-- ============================================================================
-- 0040  Images in the shared room and in direct messages
-- ============================================================================
--
-- Bytes live in Cloudflare R2, reached through short-lived presigned URLs
-- minted by the `message-image-urls` Edge Function. The database stores only
-- an object key and the image's dimensions; it never sees pixel data, the
-- same division `board_tiles` already uses (migration 0018).
--
-- WHY R2 AND NOT SUPABASE STORAGE, WHEN AVATARS USE SUPABASE STORAGE
-- ---------------------------------------------------------------------
-- Asked for. It also happens to be the right half of the existing split:
-- avatars are public by nature — anyone who can see a profile can see its
-- picture — so they sit in a public Supabase bucket and `avatarUrl` is
-- string construction with no round trip. A DM image is the opposite: only
-- two people may ever see it, and R2 has no row-level security of its own,
-- so something has to stand between the browser and the bucket and apply a
-- rule. That something is an Edge Function, which is exactly the shape
-- board tiles already needed. Reusing it beats inventing a third pattern.
--
-- THE OBJECT KEY IS THE AUTHORIZATION, SO ITS SHAPE IS LOAD-BEARING
-- ---------------------------------------------------------------------
--   room:  chat/<author_id>/<uuid>.jpg
--   dm:    dm/<thread_id>/<author_id>/<uuid>.jpg
--
-- Both halves matter and neither is decoration:
--
--   * The AUTHOR segment is what `send_chat_message` and `send_dm` check
--     below. Without it, anyone could pass a key someone else uploaded and
--     publish another person's image under their own name.
--   * The THREAD segment is what lets the Edge Function decide who may read
--     a DM image WITHOUT a database round trip per image being the only
--     option — it reads the thread id straight out of the key and checks
--     membership. A flat `dm/<uuid>.jpg` would make every read either
--     unauthorizable or dependent on a lookup through the message that
--     references it, which breaks the moment a message is deleted and its
--     image is not.
--
-- These functions do NOT verify the object exists in the bucket. They
-- cannot — the database has no R2 credentials, and by design. A key that
-- points at nothing renders as a broken image for the person who sent it,
-- which is the same outcome as a failed upload and needs no special state.
--
-- WHAT IS NOT BUILT
-- ---------------------------------------------------------------------
--   * One image per message. `post_media` (migration 0003) models many, with
--     an `ord`; nothing has ever written to it. Messages take the simple
--     shape until something actually needs galleries.
--   * No thumbnails or transcoding. The client downscales and re-encodes to
--     JPEG before upload (see apps/web/src/web/messageImage.ts), so what is
--     stored is already display-sized. A server-side pipeline is a real
--     feature, not a detail to slip in here.
--   * No orphan cleanup. An image uploaded for a message that is never sent
--     stays in the bucket, and deleting a message does not delete its
--     object. Both need a sweeper with R2 credentials; noted rather than
--     pretended. The upload URL is short-lived, so the exposure is a wasted
--     object, not an open door.
--
-- UNVERIFIED — reviewed, not executed, same as every migration since 0025.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- Columns
-- ----------------------------------------------------------------------------
-- Dimensions are stored because the renderer needs them BEFORE the bytes
-- arrive: without a width and height to reserve space from, every image in a
-- scrolling list shifts the messages under it the moment it decodes. They
-- are the client's report of what it uploaded, not something the database
-- can verify, which is fine — the cost of a wrong number is a layout jump,
-- the same jump as not having one.
alter table public.chat_messages
  add column image_path   text,
  add column image_width  integer,
  add column image_height integer,
  add constraint chat_messages_image_complete check (
    (image_path is null and image_width is null and image_height is null)
    or (image_path is not null and image_width > 0 and image_height > 0)
  );

alter table public.dm_messages
  add column image_path   text,
  add column image_width  integer,
  add column image_height integer,
  add constraint dm_messages_image_complete check (
    (image_path is null and image_width is null and image_height is null)
    or (image_path is not null and image_width > 0 and image_height > 0)
  );

-- An image-only message has no body, so the "1 to N characters" check has to
-- become "empty is allowed, but only alongside an image". Dropped and
-- replaced rather than loosened in place, because the old constraint is the
-- thing that guaranteed a message was never entirely empty and that
-- guarantee has to survive in the new one.
alter table public.chat_messages
  drop constraint chat_messages_body_check,
  add constraint chat_messages_body_check check (length(body) <= 500),
  add constraint chat_messages_not_empty check (
    length(trim(body)) > 0 or image_path is not null
  );

alter table public.dm_messages
  drop constraint dm_messages_body_check,
  add constraint dm_messages_body_check check (length(body) <= 1000),
  add constraint dm_messages_not_empty check (
    length(trim(body)) > 0 or image_path is not null
  );


-- ----------------------------------------------------------------------------
-- soso.owns_message_image — the key-shape check both senders share
-- ----------------------------------------------------------------------------
-- One definition, called from both send functions, because "does this key
-- belong to this caller" is a security question and two copies of a security
-- question drift. `p_thread_id` is null for the room.
--
-- Deliberately strict about the whole shape rather than just looking for the
-- author's id somewhere in the string: a key like
-- `dm/<other-thread>/<victim>/x.jpg?../<me>/` must not pass because it
-- happens to contain the caller's id. It is checked segment by segment.
-- ----------------------------------------------------------------------------
create or replace function soso.owns_message_image(
  p_key       text,
  p_user_id   uuid,
  p_thread_id uuid
)
  returns boolean
  language sql
  immutable
as $$
  select case
    when p_key is null then true
    -- No traversal, no absolute paths, no empty segments. R2 keys are
    -- opaque strings, so ".." is not special to the bucket — but it is
    -- special to anything downstream that treats a key as a path, and this
    -- is the one place to refuse it.
    when p_key like '%..%' or p_key like '/%' or p_key like '%//%' then false
    when p_thread_id is null then
      p_key like 'chat/' || p_user_id::text || '/%'
      -- Exactly one segment after the author id, i.e. the filename.
      and array_length(string_to_array(p_key, '/'), 1) = 3
    else
      p_key like 'dm/' || p_thread_id::text || '/' || p_user_id::text || '/%'
      and array_length(string_to_array(p_key, '/'), 1) = 4
  end;
$$;


-- ----------------------------------------------------------------------------
-- Reply previews carry the image too
-- ----------------------------------------------------------------------------
-- A quote of an image-only message would otherwise be a blank line. The
-- preview carries the path so the quoting bubble can show a thumbnail, and
-- the dimensions so it can do so without reflowing.
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
    'image_height', m.image_height
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
    'image_height', m.image_height
  )
  from public.dm_messages m
  where p_id is not null and m.id = p_id;
$$;


-- ----------------------------------------------------------------------------
-- send_chat_message
-- ----------------------------------------------------------------------------
create or replace function public.send_chat_message(
  p_body       text,
  p_reply_to   uuid default null,
  p_image_path text default null,
  p_image_w    integer default null,
  p_image_h    integer default null
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
  v_recent integer;
  v_row    public.chat_messages;
  v_author public.profiles;
begin
  if v_uid is null then
    perform soso.fail('soso/unauthenticated');
  end if;
  -- Empty is allowed now, but only with an image attached.
  if length(v_body) = 0 and v_image is null then
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
  end if;
  if p_reply_to is not null and not exists (select 1 from public.chat_messages where id = p_reply_to) then
    perform soso.fail('soso/message_not_found');
  end if;

  -- 20 messages per 5 minutes. Chat is expected to be far more frequent
  -- than posting, so this is a much looser ceiling than create_post's
  -- hourly limit — meant to stop a flood, not to pace ordinary
  -- conversation.
  select count(*)::integer into v_recent
  from public.chat_messages
  where author_id = v_uid and created_at > now() - interval '5 minutes';

  if v_recent >= 20 then
    perform soso.fail('soso/rate_limited');
  end if;

  insert into public.chat_messages (author_id, body, reply_to_id, image_path, image_width, image_height)
  values (v_uid, v_body, p_reply_to, v_image,
          case when v_image is null then null else p_image_w end,
          case when v_image is null then null else p_image_h end)
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
    'image_height', v_row.image_height
  );
end;
$$;

grant execute on function public.send_chat_message(text, uuid, text, integer, integer) to authenticated;
-- The two-argument shape would otherwise linger as an overload that writes
-- no image and silently drops one a stale client tried to attach.
drop function if exists public.send_chat_message(text, uuid);


-- ----------------------------------------------------------------------------
-- send_dm
-- ----------------------------------------------------------------------------
create or replace function public.send_dm(
  p_thread_id  uuid,
  p_body       text,
  p_reply_to   uuid default null,
  p_image_path text default null,
  p_image_w    integer default null,
  p_image_h    integer default null
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

  if length(v_body) = 0 and v_image is null then
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
  end if;

  -- Must belong to the SAME thread, not merely exist — this is what makes
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

  insert into public.dm_messages (thread_id, sender_id, body, reply_to_id, image_path, image_width, image_height)
  values (p_thread_id, v_uid, v_body, p_reply_to, v_image,
          case when v_image is null then null else p_image_w end,
          case when v_image is null then null else p_image_h end)
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
    'image_height', v_row.image_height
  );
end;
$$;

grant execute on function public.send_dm(uuid, text, uuid, text, integer, integer) to authenticated;
drop function if exists public.send_dm(uuid, text, uuid);


-- ----------------------------------------------------------------------------
-- The list functions, carrying the new columns
-- ----------------------------------------------------------------------------
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


-- ----------------------------------------------------------------------------
-- list_dm_threads — the inbox preview line for an image-only message
-- ----------------------------------------------------------------------------
-- `last_body` is empty for an image-only message, which would render as a
-- blank row. `last_has_image` lets the client say "Photo" (with its own
-- wording and its own icon) rather than the server inventing a string that
-- would then need translating.
-- ----------------------------------------------------------------------------
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
      select body, sender_id, image_path
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
-- dm_image_participants — the read check the Edge Function calls
-- ----------------------------------------------------------------------------
-- Answers one question: may the caller see images belonging to this thread?
-- Kept in SQL rather than reimplemented in the function so it uses the same
-- membership and block rules as everything else, and cannot drift from them.
--
-- SECURITY DEFINER with its own auth.uid() check, called by the Edge
-- Function on the CALLER's behalf (with their JWT, not the service key), so
-- the answer is about whoever is actually asking.
-- ----------------------------------------------------------------------------
create or replace function public.may_read_dm_thread(p_thread_id uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.dm_threads t
    where t.id = p_thread_id
      and auth.uid() in (t.user_low, t.user_high)
      and not soso.is_blocked_pair(t.user_low, t.user_high)
  );
$$;

grant execute on function public.may_read_dm_thread(uuid) to authenticated;
