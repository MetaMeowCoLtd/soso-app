-- ============================================================================
-- 0046  Photos and video on posts, video in messages
-- ============================================================================
--
-- Two things arrive together because they are one idea: an attachment is a
-- picture OR a clip, and every table that already stored "the image on this
-- thing" learns to store either.
--
-- WHY THERE IS NO TRANSCODING HERE, AND WHAT PAYS FOR THAT
-- ---------------------------------------------------------------------
-- Nothing in this migration touches a video. There is no server-side
-- pipeline, no Cloudflare Stream, and deliberately no storage bill that
-- scales with what people happen to film. Every clip is shrunk on the
-- sender's own device before it is uploaded -- see
-- apps/web/src/web/videoEncode.ts, which plays the file through a <video>
-- element (so the platform does the decoding, HEVC and all) and re-encodes
-- the frames through WebCodecs into a bounded H.264 MP4.
--
-- That is the first thing the Instagram and Facebook apps do too. What this
-- app does NOT have is the rest of their pipeline: a per-title bitrate
-- ladder, adaptive streaming, a CDN, and custom silicon to make the encoding
-- affordable. One object is stored and one object is served to everyone. So
-- the ceilings in `message-video.ts` are tight where theirs are generous,
-- and that is a property of the architecture rather than a number waiting to
-- be raised.
--
-- The database's part is therefore small and boring: remember WHICH KIND of
-- object a key points at, remember the poster frame, remember how long it
-- runs. It never sees a byte of either.
--
-- WHY A POSTER IS REQUIRED FOR VIDEO
-- ---------------------------------------------------------------------
-- A video with no poster renders as a black rectangle until it buffers, in a
-- feed that may never be scrolled to it. The poster is a second object,
-- uploaded alongside, and the check constraints below make "video without a
-- poster" unrepresentable rather than merely discouraged.
--
-- WHY THE COLUMNS ARE STILL CALLED image_*
-- ---------------------------------------------------------------------
-- `chat_messages.image_path` now holds a video key as often as a photo one,
-- and renaming it would read better. It is not renamed, because the rename
-- would have to land in the same breath as a web deploy: between a database
-- push and the client shipping, every send would fail on a parameter that no
-- longer exists. The column is the ATTACHMENT key; `media_kind` says what
-- kind. Named here so the next reader does not have to work it out.
--
-- WHAT IS NOT BUILT
-- ---------------------------------------------------------------------
--   * One attachment per post and per message. `post_media` models many (it
--     has an `ord`), and that stays, so carousels need a composer rather
--     than a migration.
--   * No server-side thumbnailing, transcoding or duration check. Width,
--     height and duration are the client's report, exactly as the image
--     dimensions already were. A wrong number costs a layout jump.
--   * Still no orphan sweeper. 0040's note stands, and video makes it
--     matter more: an abandoned clip is megabytes, not kilobytes.
--
-- UNVERIFIED -- reviewed, not executed, same as every migration since 0025.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- media_kind
-- ----------------------------------------------------------------------------
-- An enum rather than a boolean, because "is it a video" stops being a yes/no
-- question the moment anything else is attachable -- an audio note, a file --
-- and widening an enum is an ALTER TYPE while widening a boolean is a
-- migration that has to rewrite every reader.
create type public.media_kind as enum ('image', 'video');


-- ----------------------------------------------------------------------------
-- Message attachments learn a kind
-- ----------------------------------------------------------------------------
-- `default 'image'` is what makes this additive: every row written since
-- migration 0040 is a photo, and says so without being touched.
alter table public.chat_messages
  add column media_kind  public.media_kind not null default 'image',
  add column poster_path text,
  add column duration_ms integer,
  add constraint chat_messages_video_complete check (
    (media_kind = 'image' and poster_path is null and duration_ms is null)
    or (media_kind = 'video' and image_path is not null and poster_path is not null
        and duration_ms is not null and duration_ms > 0)
  );

alter table public.dm_messages
  add column media_kind  public.media_kind not null default 'image',
  add column poster_path text,
  add column duration_ms integer,
  add constraint dm_messages_video_complete check (
    (media_kind = 'image' and poster_path is null and duration_ms is null)
    or (media_kind = 'video' and image_path is not null and poster_path is not null
        and duration_ms is not null and duration_ms > 0)
  );


-- ----------------------------------------------------------------------------
-- post_media learns the same three things
-- ----------------------------------------------------------------------------
-- The table has existed since migration 0003 and nothing has ever written to
-- it -- `create_post` below is its first writer, and `allows_media` on
-- post_categories gets its first reader in the same function.
alter table public.post_media
  add column kind        public.media_kind not null default 'image',
  add column poster_key  text,
  add column duration_ms integer,
  add constraint post_media_video_complete check (
    (kind = 'image' and poster_key is null and duration_ms is null)
    or (kind = 'video' and poster_key is not null and duration_ms is not null and duration_ms > 0)
  );


-- ----------------------------------------------------------------------------
-- soso.owns_post_media
-- ----------------------------------------------------------------------------
-- The post-side twin of `soso.owns_message_image` (0040), and strict about
-- the whole key shape for the same reason: a key like
-- `post/<victim>/x.mp4?../<me>/` must not pass merely because the caller's id
-- appears somewhere in the string. Checked segment by segment.
--
--   post/<author_id>/<uuid>.<ext>
--
-- The author segment is what the Edge Function mints and what `create_post`
-- verifies, which together make "you can only publish objects you uploaded"
-- true by construction rather than by trust.
-- ----------------------------------------------------------------------------
create or replace function soso.owns_post_media(p_key text, p_user_id uuid)
  returns boolean
  language sql
  immutable
as $$
  select case
    when p_key is null then true
    when p_key like '%..%' or p_key like '/%' or p_key like '%//%' then false
    else
      p_key like 'post/' || p_user_id::text || '/%'
      -- Exactly one segment after the author id, i.e. the filename.
      and array_length(string_to_array(p_key, '/'), 1) = 3
  end;
$$;


-- ----------------------------------------------------------------------------
-- soso.post_media_json
-- ----------------------------------------------------------------------------
-- One definition of "a post's media, as the client wants it". Extracted
-- because four read paths inlined the identical subquery, and adding three
-- fields to four copies is how they drift.
--
-- Keys stay short (`key`/`w`/`h`) to match what `decodePostDetail` already
-- parses; the new ones are spelled out because nothing was reading them yet.
-- ----------------------------------------------------------------------------
create or replace function soso.post_media_json(p_post_id uuid)
  returns jsonb
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select coalesce(
    (select jsonb_agg(
              jsonb_build_object(
                'key',         m.object_key,
                'w',           m.width,
                'h',           m.height,
                'kind',        m.kind,
                'poster',      m.poster_key,
                'duration_ms', m.duration_ms
              )
              order by m.ord)
     from public.post_media m where m.post_id = p_post_id),
    '[]'::jsonb
  );
$$;


-- ----------------------------------------------------------------------------
-- The message functions, carrying the kind, the poster and the duration
-- ----------------------------------------------------------------------------
create or replace function soso.chat_reply_preview(p_id uuid)
  returns jsonb
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', m.id,
    'body', m.body,
    'author_name', p.display_name,
    'image_path', m.image_path,
    'image_width', m.image_width,
    'image_height', m.image_height,
    'media_kind', m.media_kind,
    'poster_path', m.poster_path,
    'has_post', m.shared_post_id is not null
  )
  from public.chat_messages m
  join public.profiles p on p.id = m.author_id
  where p_id is not null and m.id = p_id;
$$;

create or replace function soso.dm_reply_preview(p_id uuid)
  returns jsonb
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', m.id,
    'body', m.body,
    'sender_id', m.sender_id,
    'image_path', m.image_path,
    'image_width', m.image_width,
    'image_height', m.image_height,
    'media_kind', m.media_kind,
    'poster_path', m.poster_path,
    'has_post', m.shared_post_id is not null
  )
  from public.dm_messages m
  where p_id is not null and m.id = p_id;
$$;

create or replace function public.send_chat_message(
  p_body           text,
  p_reply_to       uuid default null,
  p_image_path     text default null,
  p_image_w        integer default null,
  p_image_h        integer default null,
  p_shared_post_id uuid default null,
  p_media_kind     text default null,
  p_poster_path    text default null,
  p_duration_ms    integer default null
)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = public, extensions, pg_temp
as $$
declare
  v_uid    uuid := auth.uid();
  v_body   text := trim(coalesce(p_body, ''));
  v_image  text := nullif(trim(coalesce(p_image_path, '')), '');
  v_poster text := nullif(trim(coalesce(p_poster_path, '')), '');
  v_kind   public.media_kind := coalesce(nullif(trim(coalesce(p_media_kind, '')), ''), 'image')::public.media_kind;
  v_recent integer;
  v_row    public.chat_messages;
  v_author public.profiles;
begin
  if v_uid is null then
    perform soso.fail('soso/unauthenticated');
  end if;
  -- Empty is allowed, but only with something else attached.
  if length(v_body) = 0 and v_image is null and p_shared_post_id is null then
    perform soso.fail('soso/empty_message');
  end if;
  if length(v_body) > 500 then
    perform soso.fail('soso/message_too_long');
  end if;
  if v_image is not null then
    if not soso.owns_message_image(v_image, v_uid, null) then
      perform soso.fail('soso/forbidden');
    end if;
    if p_image_w is null or p_image_h is null or p_image_w <= 0 or p_image_h <= 0 then
      perform soso.fail('soso/bad_request');
    end if;
    -- A video carries two objects, and the poster has to be the caller's own
    -- for the same reason the video is: the key IS the authorization.
    if v_kind = 'video' then
      if v_poster is null or not soso.owns_message_image(v_poster, v_uid, null) then
        perform soso.fail('soso/bad_request');
      end if;
    else
      v_poster := null;
    end if;
  end if;
  perform soso.assert_shareable_post(p_shared_post_id, v_uid, true);
  if p_reply_to is not null and not exists (select 1 from public.chat_messages where id = p_reply_to) then
    perform soso.fail('soso/message_not_found');
  end if;

  -- 20 messages per 5 minutes. Chat is expected to be far more frequent than
  -- posting, so this is a much looser ceiling than create_post's hourly limit
  -- -- meant to stop a flood, not to pace ordinary conversation.
  select count(*)::integer into v_recent
  from public.chat_messages
  where author_id = v_uid and created_at > now() - interval '5 minutes';

  if v_recent >= 20 then
    perform soso.fail('soso/rate_limited');
  end if;

  insert into public.chat_messages (
    author_id, body, reply_to_id, image_path, image_width, image_height, shared_post_id,
    media_kind, poster_path, duration_ms
  )
  values (v_uid, v_body, p_reply_to, v_image,
          case when v_image is null then null else p_image_w end,
          case when v_image is null then null else p_image_h end,
          p_shared_post_id,
          case when v_image is null then 'image'::public.media_kind else v_kind end,
          v_poster,
          case when v_kind = 'video' then p_duration_ms else null end)
  returning * into v_row;

  select * into v_author from public.profiles where id = v_uid;

  return jsonb_build_object(
    'id', v_row.id,
    'body', v_row.body,
    'created_at', v_row.created_at,
    'author_id', v_row.author_id,
    'author_handle', v_author.handle,
    'author_name', v_author.display_name,
    'author_avatar', v_author.avatar_path,
    'mine', true,
    'reply_to', soso.chat_reply_preview(p_reply_to),
    'reactions', '[]'::jsonb,
    'image_path', v_row.image_path,
    'image_width', v_row.image_width,
    'image_height', v_row.image_height,
    'media_kind', v_row.media_kind,
    'poster_path', v_row.poster_path,
    'duration_ms', v_row.duration_ms,
    'shared_post', soso.shared_post_card(v_row.shared_post_id, v_uid)
  );
end;
$$;

create or replace function public.send_dm(
  p_thread_id      uuid,
  p_body           text,
  p_reply_to       uuid default null,
  p_image_path     text default null,
  p_image_w        integer default null,
  p_image_h        integer default null,
  p_shared_post_id uuid default null,
  p_media_kind     text default null,
  p_poster_path    text default null,
  p_duration_ms    integer default null
)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = public, extensions, pg_temp
as $$
declare
  v_uid    uuid := auth.uid();
  v_body   text := trim(coalesce(p_body, ''));
  v_image  text := nullif(trim(coalesce(p_image_path, '')), '');
  v_poster text := nullif(trim(coalesce(p_poster_path, '')), '');
  v_kind   public.media_kind := coalesce(nullif(trim(coalesce(p_media_kind, '')), ''), 'image')::public.media_kind;
  v_thread public.dm_threads;
  v_other  uuid;
  v_recent integer;
  v_row    public.dm_messages;
begin
  if v_uid is null then
    perform soso.fail('soso/unauthenticated');
  end if;

  select * into v_thread from public.dm_threads where id = p_thread_id;
  if v_thread.id is null or v_uid not in (v_thread.user_low, v_thread.user_high) then
    perform soso.fail('soso/thread_not_found');
  end if;

  v_other := case when v_uid = v_thread.user_low then v_thread.user_high else v_thread.user_low end;

  if not soso.dm_can_message(v_uid, v_other) then
    perform soso.fail('soso/not_friends');
  end if;

  if length(v_body) = 0 and v_image is null and p_shared_post_id is null then
    perform soso.fail('soso/empty_message');
  end if;
  if length(v_body) > 1000 then
    perform soso.fail('soso/message_too_long');
  end if;
  if v_image is not null then
    -- Bound to THIS thread, not merely to this caller: a key minted for one
    -- conversation must not be publishable into another, or an image the
    -- Edge Function will hand to thread A's members ends up referenced from
    -- thread B, whose members it would then also be minted for.
    if not soso.owns_message_image(v_image, v_uid, p_thread_id) then
      perform soso.fail('soso/forbidden');
    end if;
    if p_image_w is null or p_image_h is null or p_image_w <= 0 or p_image_h <= 0 then
      perform soso.fail('soso/bad_request');
    end if;
    -- A video carries two objects, and the poster has to be the caller's own
    -- for the same reason the video is: the key IS the authorization.
    if v_kind = 'video' then
      if v_poster is null or not soso.owns_message_image(v_poster, v_uid, p_thread_id) then
        perform soso.fail('soso/bad_request');
      end if;
    else
      v_poster := null;
    end if;
  end if;

  -- Only that the SHARER may see it. Whether the recipient may is answered
  -- separately, per read, by soso.shared_post_card -- which is the right
  -- place for it: the answer can change after the message is sent, in either
  -- direction, as follows and close-friend tiers change.
  perform soso.assert_shareable_post(p_shared_post_id, v_uid, false);

  -- Must belong to the SAME thread, not merely exist -- this is what makes
  -- soso.dm_reply_preview's own lack of an authorization check safe: a reply
  -- can never point out of the conversation it was sent in.
  if p_reply_to is not null
     and not exists (select 1 from public.dm_messages where id = p_reply_to and thread_id = p_thread_id) then
    perform soso.fail('soso/message_not_found');
  end if;

  select count(*)::integer into v_recent
  from public.dm_messages
  where sender_id = v_uid and created_at > now() - interval '5 minutes';

  if v_recent >= 60 then
    perform soso.fail('soso/rate_limited');
  end if;

  insert into public.dm_messages (
    thread_id, sender_id, body, reply_to_id, image_path, image_width, image_height,
    shared_post_id, media_kind, poster_path, duration_ms
  )
  values (p_thread_id, v_uid, v_body, p_reply_to, v_image,
          case when v_image is null then null else p_image_w end,
          case when v_image is null then null else p_image_h end,
          p_shared_post_id,
          case when v_image is null then 'image'::public.media_kind else v_kind end,
          v_poster,
          case when v_kind = 'video' then p_duration_ms else null end)
  returning * into v_row;

  update public.dm_threads
    set last_message_at = v_row.created_at,
        low_read_at  = case when v_uid = user_low  then v_row.created_at else low_read_at  end,
        high_read_at = case when v_uid = user_high then v_row.created_at else high_read_at end
    where id = p_thread_id;

  return jsonb_build_object(
    'id', v_row.id,
    'thread_id', v_row.thread_id,
    'sender_id', v_row.sender_id,
    'body', v_row.body,
    'created_at', v_row.created_at,
    'mine', true,
    'reply_to', soso.dm_reply_preview(p_reply_to),
    'reactions', '[]'::jsonb,
    'image_path', v_row.image_path,
    'image_width', v_row.image_width,
    'image_height', v_row.image_height,
    'media_kind', v_row.media_kind,
    'poster_path', v_row.poster_path,
    'duration_ms', v_row.duration_ms,
    'shared_post', soso.shared_post_card(v_row.shared_post_id, v_uid)
  );
end;
$$;

create or replace function public.list_recent_chat_messages(
  p_before timestamptz default null,
  p_limit  integer default 50
)
  returns jsonb
  language sql
  stable
  security definer
  set search_path = public, extensions, pg_temp
as $$
  select coalesce(jsonb_agg(row_json order by created_at asc), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'id', m.id,
      'body', m.body,
      'created_at', m.created_at,
      'author_id', m.author_id,
      'author_handle', p.handle,
      'author_name', p.display_name,
      'author_avatar', p.avatar_path,
      'mine', m.author_id = auth.uid(),
      'reply_to', soso.chat_reply_preview(m.reply_to_id),
      'image_path', m.image_path,
      'image_width', m.image_width,
      'image_height', m.image_height,
      'media_kind', m.media_kind,
      'poster_path', m.poster_path,
      'duration_ms', m.duration_ms,
      'shared_post', soso.shared_post_card(m.shared_post_id, auth.uid()),
      'seen_by', (
        select count(*)
        from public.chat_room_reads r
        where r.read_at >= m.created_at
          and r.user_id <> m.author_id
      ),
      'reactions', coalesce(
        (
          select jsonb_agg(
            jsonb_build_object('emoji', r.emoji, 'count', r.n, 'mine', r.mine)
            order by r.emoji
          )
          from (
            select emoji, count(*)::int as n, bool_or(user_id = auth.uid()) as mine
            from public.chat_message_reactions
            where message_id = m.id
            group by emoji
          ) r
        ),
        '[]'::jsonb
      )
    ) as row_json,
    m.created_at
    from public.chat_messages m
    join public.profiles p on p.id = m.author_id
    where p_before is null or m.created_at < p_before
    order by m.created_at desc
    limit least(greatest(coalesce(p_limit, 50), 1), 100)
  ) recent;
$$;

create or replace function public.list_dm_messages(
  p_thread_id uuid,
  p_before    timestamptz default null,
  p_limit     integer default 50
)
  returns jsonb
  language plpgsql
  stable
  security definer
  set search_path = public, extensions, pg_temp
as $$
declare
  v_uid    uuid := auth.uid();
  v_thread public.dm_threads;
  v_other  uuid;
begin
  if v_uid is null then
    perform soso.fail('soso/unauthenticated');
  end if;

  select * into v_thread from public.dm_threads where id = p_thread_id;
  if v_thread.id is null or v_uid not in (v_thread.user_low, v_thread.user_high) then
    perform soso.fail('soso/thread_not_found');
  end if;

  v_other := case when v_uid = v_thread.user_low then v_thread.user_high else v_thread.user_low end;
  if soso.is_blocked_pair(v_uid, v_other) then
    perform soso.fail('soso/thread_not_found');
  end if;

  return (
    select coalesce(jsonb_agg(row_json order by created_at asc), '[]'::jsonb)
    from (
      select jsonb_build_object(
        'id', m.id,
        'thread_id', m.thread_id,
        'sender_id', m.sender_id,
        'body', m.body,
        'created_at', m.created_at,
        'mine', m.sender_id = v_uid,
        'reply_to', soso.dm_reply_preview(m.reply_to_id),
        'image_path', m.image_path,
        'image_width', m.image_width,
        'image_height', m.image_height,
        'media_kind', m.media_kind,
        'poster_path', m.poster_path,
        'duration_ms', m.duration_ms,
        'shared_post', soso.shared_post_card(m.shared_post_id, v_uid),
        'reactions', coalesce(
          (
            select jsonb_agg(
                     jsonb_build_object('emoji', g.emoji, 'count', g.n, 'mine', g.mine)
                     order by g.first_at
                   )
            from (
              select r.emoji,
                     count(*)                   as n,
                     bool_or(r.user_id = v_uid) as mine,
                     min(r.created_at)          as first_at
              from public.dm_message_reactions r
              where r.message_id = m.id
              group by r.emoji
            ) g
          ),
          '[]'::jsonb
        )
      ) as row_json,
      m.created_at
      from public.dm_messages m
      where m.thread_id = p_thread_id
        and (p_before is null or m.created_at < p_before)
      order by m.created_at desc
      limit least(greatest(coalesce(p_limit, 50), 1), 100)
    ) page
  );
end;
$$;

create or replace function public.list_dm_threads()
  returns jsonb
  language sql
  stable
  security definer
  set search_path = public, extensions, pg_temp
as $$
  select coalesce(jsonb_agg(row_json order by sort_at desc nulls last), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'id', t.id,
      'other_id', o.id,
      'other_handle', o.handle,
      'other_name', o.display_name,
      'other_avatar', o.avatar_path,
      'last_message_at', t.last_message_at,
      'last_body', m.body,
      'last_has_image', m.image_path is not null,
      'last_media_kind', m.media_kind,
      'last_has_post', m.shared_post_id is not null,
      'last_sender_id', m.sender_id,
      'unread', (
        select count(*)
        from public.dm_messages n
        where n.thread_id = t.id
          and n.sender_id <> auth.uid()
          and n.created_at > coalesce(
            case when auth.uid() = t.user_low then t.low_read_at else t.high_read_at end,
            'epoch'::timestamptz
          )
      )
    ) as row_json,
    t.last_message_at as sort_at
    from public.dm_threads t
    join public.profiles o
      on o.id = case when auth.uid() = t.user_low then t.user_high else t.user_low end
    left join lateral (
      select body, sender_id, image_path, shared_post_id, media_kind
      from public.dm_messages
      where thread_id = t.id
      order by created_at desc
      limit 1
    ) m on true
    where auth.uid() in (t.user_low, t.user_high)
      and not soso.is_blocked_pair(t.user_low, t.user_high)
  ) threads;
$$;

-- ----------------------------------------------------------------------------
-- create_post -- now the first writer post_media has ever had
-- ----------------------------------------------------------------------------
-- Restated from 0042, plus the media parameters and their validation. Note
-- `allows_media`: the column has sat in post_categories since 0003 without a
-- single reader, because nothing could attach anything. A category with it
-- false now refuses attachments instead of ignoring the flag.
-- ----------------------------------------------------------------------------
create or replace function public.create_post(
  p_category     text,
  p_lng          double precision,
  p_lat          double precision,
  p_subtype      text             default null,
  p_body         text             default null,
  p_device_lng   double precision default null,
  p_device_lat   double precision default null,
  p_ttl_minutes  integer          default null,
  p_audience     public.post_audience default null,
  p_recipients   uuid[]           default null,
  p_media_key    text             default null,
  p_media_kind   text             default null,
  p_media_w      integer          default null,
  p_media_h      integer          default null,
  p_media_poster text             default null,
  p_media_ms     integer          default null
)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = public, extensions, pg_temp
as $$
declare
  v_uid       uuid := auth.uid();
  v_profile   public.profiles;
  v_cat       public.post_categories;
  v_target    extensions.geography;
  v_device    extensions.geography;
  v_ttl       interval;
  v_post      public.posts;
  v_recent    integer;
  v_zone      public.zones;
  v_audience  public.post_audience;
  v_recipient uuid;
  v_media     text := nullif(trim(coalesce(p_media_key, '')), '');
  v_poster    text := nullif(trim(coalesce(p_media_poster, '')), '');
  v_kind      public.media_kind;
begin
  ---------------------------------------------------------------- identity
  if v_uid is null then
    perform soso.fail('soso/unauthenticated');
  end if;

  select * into v_profile from public.profiles where id = v_uid;
  if not found then
    perform soso.fail('soso/no_profile');
  end if;
  if v_profile.banned_until is not null and v_profile.banned_until > now() then
    perform soso.fail('soso/banned');
  end if;

  ---------------------------------------------------------------- category
  select * into v_cat from public.post_categories where key = p_category;
  if not found or not v_cat.is_enabled then
    perform soso.fail('soso/category_unavailable');
  end if;
  if v_profile.reputation < v_cat.min_reputation then
    perform soso.fail('soso/reputation_too_low');
  end if;

  if p_subtype is not null then
    if not exists (
      select 1 from public.post_subtypes
      where category_key = p_category and key = p_subtype and is_enabled
    ) then
      perform soso.fail('soso/invalid_subtype');
    end if;
  end if;

  ---------------------------------------------------------------- body
  if p_body is not null and length(trim(p_body)) > 0 then
    if not v_cat.allows_body then
      perform soso.fail('soso/body_not_allowed');
    end if;
    if length(p_body) > v_cat.body_max_length then
      perform soso.fail('soso/body_too_long');
    end if;
  end if;

  ---------------------------------------------------------------- media
  if v_media is not null then
    -- `allows_media` has sat in post_categories since 0003 without a single
    -- reader, because nothing could attach anything. This is that reader.
    if not v_cat.allows_media then
      perform soso.fail('soso/media_not_allowed');
    end if;
    -- The key is the authorization, exactly as it is for message images
    -- (0040): it carries the author's id, and this is what stops someone
    -- publishing an object another account uploaded under their own name.
    if not soso.owns_post_media(v_media, v_uid) then
      perform soso.fail('soso/forbidden');
    end if;
    if p_media_w is null or p_media_h is null or p_media_w <= 0 or p_media_h <= 0 then
      perform soso.fail('soso/bad_request');
    end if;
    v_kind := coalesce(nullif(trim(coalesce(p_media_kind, '')), ''), 'image')::public.media_kind;
    if v_kind = 'video' then
      -- A video with no poster would render as a black rectangle until it
      -- buffered, in a feed that may never be scrolled to it. The poster is
      -- part of the attachment, not a nicety.
      if v_poster is null or not soso.owns_post_media(v_poster, v_uid) then
        perform soso.fail('soso/bad_request');
      end if;
    else
      -- An image has nothing to poster, and carrying one would be a second
      -- object nothing reads.
      v_poster := null;
    end if;
  end if;

  ---------------------------------------------------------------- rate limit
  select count(*)::integer into v_recent
  from public.posts
  where author_id = v_uid and created_at > now() - interval '1 hour';

  if v_recent >= v_cat.hourly_post_limit then
    perform soso.fail('soso/rate_limited');
  end if;

  ---------------------------------------------------------------- location
  if v_cat.requires_location then
    if p_lng is null or p_lat is null
       or p_lng < -180 or p_lng > 180 or p_lat < -85 or p_lat > 85 then
      perform soso.fail('soso/invalid_location');
    end if;

    v_target := st_point(p_lng, p_lat, 4326)::geography;

    if v_cat.requires_proximity then
      if p_device_lng is null or p_device_lat is null then
        perform soso.fail('soso/device_location_required');
      end if;
      v_device := st_point(p_device_lng, p_device_lat, 4326)::geography;
      if st_distance(v_device, v_target) > v_cat.proximity_radius_m then
        perform soso.fail('soso/too_far_away');
      end if;
    end if;

    v_target := soso.snap(v_target, v_cat.location_precision_m);
    v_zone := soso.zone_for_point(v_uid, v_target);
  else
    -- v_target stays null; v_zone stays its default-initialised (all-null)
    -- record, so v_zone.audience and v_zone.id below both read as null,
    -- exactly the "no zone lookup involved" behaviour a location-less post
    -- needs. No separate branch is needed further down for this reason.
    v_target := null;
  end if;

  ---------------------------------------------------------------- audience
  v_audience := coalesce(p_audience, v_zone.audience, 'public');

  if v_audience = 'custom' then
    if p_recipients is null or cardinality(p_recipients) = 0 then
      perform soso.fail('soso/no_recipients');
    end if;
    if cardinality(p_recipients) > 100 then
      perform soso.fail('soso/too_many_recipients');
    end if;
  end if;

  ---------------------------------------------------------------- lifetime
  v_ttl := coalesce(
    case when p_ttl_minutes is null then null
         else make_interval(mins => greatest(p_ttl_minutes, 1)) end,
    v_cat.default_ttl
  );
  if v_ttl > v_cat.max_ttl then
    v_ttl := v_cat.max_ttl;
  end if;

  ---------------------------------------------------------------- write
  insert into public.posts (
    author_id, category_key, subtype_key, body, geom, expires_at, audience, zone_id
  )
  values (
    v_uid,
    p_category,
    p_subtype,
    nullif(trim(coalesce(p_body, '')), ''),
    v_target,
    now() + v_ttl,
    v_audience,
    case when p_audience is null then v_zone.id else null end
  )
  returning * into v_post;

  ---------------------------------------------------------------- media row
  -- One row, though the table models many (it has an `ord`). See the header:
  -- galleries are a composer problem more than a schema one, and `ord`
  -- staying means adding them later needs no migration.
  if v_media is not null then
    insert into public.post_media (
      post_id, object_key, width, height, ord, kind, poster_key, duration_ms
    )
    values (
      v_post.id, v_media, p_media_w, p_media_h, 0, v_kind, v_poster,
      case when v_kind = 'video' then p_media_ms else null end
    );
  end if;

  if v_audience = 'custom' then
    foreach v_recipient in array p_recipients loop
      if soso.is_mutual_follow(v_uid, v_recipient)
         and not soso.is_blocked_pair(v_uid, v_recipient) then
        insert into public.post_recipients (post_id, user_id)
        values (v_post.id, v_recipient)
        on conflict do nothing;
      end if;
    end loop;
  end if;

  return soso.pin(v_post);
end;
$$;

-- ----------------------------------------------------------------------------
-- The post read paths, through the one media definition
-- ----------------------------------------------------------------------------
-- Restated only to swap their inlined media subquery for
-- `soso.post_media_json`. Everything else in them is unchanged.
-- ----------------------------------------------------------------------------
create or replace function public.post_detail(p_post_id uuid)
  returns jsonb
  language sql
  stable
  security definer
  set search_path = public, extensions, pg_temp
as $$
  select soso.pin(p.*) || jsonb_build_object(
    'body',    p.body,
    'created', p.created_at,
    'up',      p.confirm_count,
    'down',    p.dispute_count,
    'address', p.address,
    'author',  jsonb_build_object(
                 'id',     a.id,
                 'handle', a.handle,
                 'name',   a.display_name,
                 'avatar', a.avatar_path
               ),
    'media', soso.post_media_json(p.id),
    'mine',    p.author_id = auth.uid(),
    'zone',    (select z.name from public.zones z where z.id = p.zone_id),
    'replies', p.reply_count,
    'liked',   exists (
                 select 1 from public.post_votes v
                 where v.post_id = p.id and v.voter_id = auth.uid() and v.vote = 1
               )
  )
  from public.posts p
  join public.profiles a on a.id = p.author_id
  where p.id = p_post_id
    and soso.can_see_post(auth.uid(), p.author_id, p.audience, p.id);
$$;

create or replace function public.list_feed_posts(
  p_before timestamptz default null,
  p_limit  integer default 20
)
  returns jsonb
  language sql
  stable
  security definer
  set search_path = public, extensions, pg_temp
as $$
  with page as (
    select
      soso.pin(p.*) || jsonb_build_object(
        'body',    p.body,
        'created', p.created_at,
        'up',      p.confirm_count,
        'down',    p.dispute_count,
        'address', p.address,
        'author',  jsonb_build_object(
                     'id',     a.id,
                     'handle', a.handle,
                     'name',   a.display_name,
                     'avatar', a.avatar_path
                   ),
        'media', soso.post_media_json(p.id),
        'mine',    p.author_id = auth.uid(),
        'zone',    null,
        'replies', p.reply_count,
        'liked',   exists (
                     select 1 from public.post_votes v
                     where v.post_id = p.id and v.voter_id = auth.uid() and v.vote = 1
                   )
      ) as row_json,
      p.created_at
    from public.posts p
    join public.profiles a on a.id = p.author_id
    where p.cell_id is null
      and p.status = 'live'
      and p.expires_at > now()
      and (p_before is null or p.created_at < p_before)
      and soso.can_see_post(auth.uid(), p.author_id, p.audience, p.id)
    order by p.created_at desc
    limit least(greatest(coalesce(p_limit, 20), 1), 50)
  )
  select jsonb_build_object(
    'cursor', (select min(created_at) from page),
    'posts',  coalesce((select jsonb_agg(row_json order by created_at desc) from page), '[]'::jsonb)
  );
$$;

create or replace function public.list_user_posts(
  p_user_id uuid,
  p_before  timestamptz default null,
  p_limit   integer default 20
)
  returns jsonb
  language sql
  stable
  security definer
  set search_path = public, extensions, pg_temp
as $$
  with page as (
    select
      soso.pin(p.*) || jsonb_build_object(
        'body',    p.body,
        'created', p.created_at,
        'up',      p.confirm_count,
        'down',    p.dispute_count,
        'address', p.address,
        'author',  jsonb_build_object(
                     'id',     a.id,
                     'handle', a.handle,
                     'name',   a.display_name,
                     'avatar', a.avatar_path
                   ),
        'media', soso.post_media_json(p.id),
        'mine',    p.author_id = auth.uid(),
        'zone',    null,
        'replies', p.reply_count,
        'liked',   exists (
                     select 1 from public.post_votes v
                     where v.post_id = p.id and v.voter_id = auth.uid() and v.vote = 1
                   )
      ) as row_json,
      p.created_at
    from public.posts p
    join public.profiles a on a.id = p.author_id
    where p.author_id = p_user_id
      -- The whole point of this migration. See the header.
      and p.cell_id is null
      and p.status = 'live'
      and p.expires_at > now()
      and (p_before is null or p.created_at < p_before)
      and soso.can_see_post(auth.uid(), p.author_id, p.audience, p.id)
    order by p.created_at desc
    limit least(greatest(coalesce(p_limit, 20), 1), 50)
  )
  select jsonb_build_object(
    'cursor', (select min(created_at) from page),
    'posts',  coalesce((select jsonb_agg(row_json order by created_at desc) from page), '[]'::jsonb)
  );
$$;

-- ----------------------------------------------------------------------------
-- Grants
-- ----------------------------------------------------------------------------
-- The three-argument send functions and the ten-argument create_post are
-- superseded, and are dropped rather than left as overloads that would accept
-- a call and silently drop whatever the caller attached -- the same trap 0040
-- and 0044 each had to defuse in turn.
grant execute on function public.send_chat_message(
  text, uuid, text, integer, integer, uuid, text, text, integer
) to authenticated;
drop function if exists public.send_chat_message(text, uuid, text, integer, integer, uuid);

grant execute on function public.send_dm(
  uuid, text, uuid, text, integer, integer, uuid, text, text, integer
) to authenticated;
drop function if exists public.send_dm(uuid, text, uuid, text, integer, integer, uuid);

grant execute on function public.create_post(
  text, double precision, double precision, text, text, double precision, double precision,
  integer, public.post_audience, uuid[], text, text, integer, integer, text, integer
) to authenticated;
drop function if exists public.create_post(
  text, double precision, double precision, text, text, double precision, double precision,
  integer, public.post_audience, uuid[]
);


-- ----------------------------------------------------------------------------
-- may_read_post_media -- the read check the Edge Function calls for post media
-- ----------------------------------------------------------------------------
-- The post-side twin of `may_read_dm_thread` (0040), and it has to exist for
-- a reason worth stating: a DM key carries its thread id, so authorizing a
-- read is pure string work, but a post media key carries only the AUTHOR.
-- Whether a given reader may see it depends on the post that references it --
-- its audience, its recipients, whether either party has blocked the other --
-- none of which is in the key.
--
-- So this resolves the key back to its post and applies the one visibility
-- predicate everything else uses. Matching `poster_key` as well as
-- `object_key` is what makes a video's poster frame readable by exactly the
-- people who may watch the video, and nobody else.
--
-- SECURITY DEFINER with its own auth.uid() check, called by the Edge Function
-- on the CALLER's behalf (their JWT, not the service key), so the answer is
-- about whoever is actually asking.
-- ----------------------------------------------------------------------------
create or replace function public.may_read_post_media(p_key text)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.post_media m
    join public.posts p on p.id = m.post_id
    where (m.object_key = p_key or m.poster_key = p_key)
      and soso.can_see_post(auth.uid(), p.author_id, p.audience, p.id)
  );
$$;

grant execute on function public.may_read_post_media(text) to authenticated;
