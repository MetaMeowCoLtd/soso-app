-- ============================================================================
-- 0048  User mentions in group chats
-- ============================================================================
--
-- @handle, Instagram's own shape: type "@", pick someone from the people
-- already in this conversation, their name is inserted, and it renders
-- highlighted and tappable to their profile. Landed as its own request after
-- a bug report literally read "(We need user mentions)" — see the room's
-- and DMs' shared long-press sheet, which already quotes and reacts to a
-- message but had no way to address one line of it at somebody specific.
--
-- WHO CAN BE MENTIONED, AND WHY THAT IS NOT A NEW RULE
-- ---------------------------------------------------------------------
-- A CURRENT MEMBER OF THE THREAD, checked the same way `soso.dm_is_member`
-- already checks everything else here. This is not a new permission model
-- bolted on for mentions — it is the existing one, because a mention that
-- could name someone OUTSIDE the conversation would be a way to put a
-- stranger's name (and, via the notification below, a stranger's phone) in
-- front of a group they were never added to, which is exactly the class of
-- contact migration 0026 and 0047 both exist to prevent.
--
-- WHY THIS IS A TABLE AND NOT A COLUMN ON dm_messages
-- ---------------------------------------------------------------------
-- A message can mention more than one person, so this follows
-- `dm_message_reactions`'s own shape rather than `event_target_id`'s: one
-- row per (message, mentioned person), not a single nullable id. Mirrored
-- deliberately, down to the RLS policy, because the visibility question is
-- identical — "can this viewer see the message at all" — and a second
-- definition of that question is a second place for it to drift from the
-- first.
--
-- HOW A MENTION IS FOUND IN THE TEXT, AND WHY THAT IS THE CLIENT'S JOB
-- ---------------------------------------------------------------------
-- The client sends the set of user ids it believes it mentioned
-- (`p_mentioned_user_ids`); this migration's only job is to keep the ones
-- that are actually real, current members and silently drop the rest —
-- someone typing "@" followed by a stranger's handle, or a member who has
-- since left, ends up mentioning nobody rather than failing the whole send.
-- Matching "@handle" back out of `body` for RENDERING is symmetric and
-- lives in `packages/core/src/domain/mentions.ts`, not in SQL: it is a pure
-- function of text plus this table's own contents, needed by a client and
-- never by a query.
-- ============================================================================

create table public.dm_message_mentions (
  message_id uuid not null references public.dm_messages (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (message_id, user_id)
);

-- No "messages that mention me" surface exists yet, but the one query that
-- feature would run — mine, across every thread, newest first — is exactly
-- what this supports and a primary key on (message_id, user_id) does not.
create index dm_message_mentions_user_idx on public.dm_message_mentions (user_id, created_at desc);

alter table public.dm_message_mentions enable row level security;

-- Identical in shape and reasoning to dm_message_reactions_read_members: a
-- mention is visible exactly when the message carrying it is, so this asks
-- the same soso.dm_thread_visible question that policy does rather than
-- restating a second version of it.
create policy dm_message_mentions_read_members on public.dm_message_mentions
  for select to authenticated
  using (
    exists (
      select 1 from public.dm_messages m
      where m.id = dm_message_mentions.message_id
        and soso.dm_thread_visible(m.thread_id, auth.uid())
    )
  );

revoke all on public.dm_message_mentions from anon, authenticated;
grant select on public.dm_message_mentions to authenticated;


-- ----------------------------------------------------------------------------
-- soso.dm_mentions_json -- one message's mentions, as the client wants them
-- ----------------------------------------------------------------------------
-- Called from both send_dm (for the row it just inserted) and
-- list_dm_messages (for every row in a page), on the same reasoning
-- soso.dm_reply_preview and soso.shared_post_card already follow: one
-- definition of "this message's X, as JSON" rather than the same
-- jsonb_build_object repeated at each call site.
--
-- `handle` is the field a client actually matches against `body` to find
-- where to draw the highlight — see mentions.ts. `name` rides along because
-- every other person-shaped object in this schema carries both, and a
-- future surface (a tooltip, a "mentioned you" list) reaching for a display
-- name should not need a second query to get one.
-- ----------------------------------------------------------------------------
create or replace function soso.dm_mentions_json(p_message_id uuid)
  returns jsonb
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select coalesce(
    (
      select jsonb_agg(
               jsonb_build_object(
                 'id',     p.id,
                 'handle', p.handle,
                 'name',   p.display_name
               )
               order by dmm.created_at
             )
      from public.dm_message_mentions dmm
      join public.profiles p on p.id = dmm.user_id
      where dmm.message_id = p_message_id
    ),
    '[]'::jsonb
  );
$$;


-- ----------------------------------------------------------------------------
-- send_dm -- restated from 0047, gaining p_mentioned_user_ids
-- ----------------------------------------------------------------------------
-- The filtering step mirrors add_group_members' own: deduplicate, drop the
-- sender (mentioning yourself is a no-op, not an error — the same call this
-- app already makes for a group's member list), then keep only ids that
-- soso.dm_is_member confirms are actually in this thread right now. Nothing
-- about a mention is re-checked later the way dm_can_message is on every
-- send elsewhere in this file, because there is nothing further TO check —
-- membership is the whole rule, and it was just verified.
-- ----------------------------------------------------------------------------
create or replace function public.send_dm(
  p_thread_id          uuid,
  p_body               text,
  p_reply_to           uuid default null,
  p_image_path         text default null,
  p_image_w            integer default null,
  p_image_h            integer default null,
  p_shared_post_id     uuid default null,
  p_media_kind         text default null,
  p_poster_path        text default null,
  p_duration_ms        integer default null,
  p_mentioned_user_ids uuid[] default '{}'
)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = public, extensions, pg_temp
as $$
declare
  v_uid       uuid := auth.uid();
  v_body      text := trim(coalesce(p_body, ''));
  v_image     text := nullif(trim(coalesce(p_image_path, '')), '');
  v_poster    text := nullif(trim(coalesce(p_poster_path, '')), '');
  v_kind      public.media_kind := coalesce(nullif(trim(coalesce(p_media_kind, '')), ''), 'image')::public.media_kind;
  v_recent    integer;
  v_row       public.dm_messages;
  v_mentioned uuid[];
  v_mention   uuid;
begin
  if v_uid is null then
    perform soso.fail('soso/unauthenticated');
  end if;

  -- Raises rather than returning false, so there is nothing to branch on here
  -- and nothing of the thread row this function needs afterwards.
  perform soso.dm_assert_can_post(p_thread_id, v_uid);

  if length(v_body) = 0 and v_image is null and p_shared_post_id is null then
    perform soso.fail('soso/empty_message');
  end if;
  if length(v_body) > 1000 then
    perform soso.fail('soso/message_too_long');
  end if;
  if v_image is not null then
    -- Bound to THIS thread, not merely to this caller: a key minted for one
    -- conversation must not be publishable into another.
    if not soso.owns_message_image(v_image, v_uid, p_thread_id) then
      perform soso.fail('soso/forbidden');
    end if;
    if p_image_w is null or p_image_h is null or p_image_w <= 0 or p_image_h <= 0 then
      perform soso.fail('soso/bad_request');
    end if;
    if v_kind = 'video' then
      if v_poster is null or not soso.owns_message_image(v_poster, v_uid, p_thread_id) then
        perform soso.fail('soso/bad_request');
      end if;
    else
      v_poster := null;
    end if;
  end if;

  -- Only that the SHARER may see it. Whether each RECIPIENT may is answered
  -- separately, per read, by soso.shared_post_card -- which in a group is the
  -- difference between a card and a placeholder for eighteen different people
  -- with eighteen different relationships to the post's author.
  perform soso.assert_shareable_post(p_shared_post_id, v_uid, false);

  -- Must belong to the SAME thread, which is what makes soso.dm_reply_preview
  -- safe without an authorization check of its own.
  if p_reply_to is not null
     and not exists (select 1 from public.dm_messages where id = p_reply_to and thread_id = p_thread_id) then
    perform soso.fail('soso/message_not_found');
  end if;

  -- Silently dropped rather than rejected: the client extracted these from
  -- "@handle" text it matched against the thread's OWN member list at the
  -- moment of typing, so the only way one of these is not a current member
  -- is a race (they left between the last keystroke and Send) or a client
  -- that did not bother checking. Either way the honest outcome is fewer
  -- mentions, not a failed message.
  select array_agg(distinct id) into v_mentioned
  from unnest(coalesce(p_mentioned_user_ids, '{}'::uuid[])) as id
  where id is not null
    and id <> v_uid
    and soso.dm_is_member(p_thread_id, id);

  v_mentioned := coalesce(v_mentioned, '{}'::uuid[]);

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

  if array_length(v_mentioned, 1) > 0 then
    foreach v_mention in array v_mentioned loop
      insert into public.dm_message_mentions (message_id, user_id)
      values (v_row.id, v_mention);
    end loop;
  end if;

  update public.dm_threads
    set last_message_at = v_row.created_at
    where id = p_thread_id;

  -- Your own send counts as having read up to that point, so a conversation
  -- never comes back unread because of something you said yourself.
  update public.dm_thread_members
    set last_read_at = v_row.created_at
    where thread_id = p_thread_id and user_id = v_uid;

  return jsonb_build_object(
    'id', v_row.id,
    'thread_id', v_row.thread_id,
    'sender_id', v_row.sender_id,
    'sender_handle', (select handle from public.profiles where id = v_uid),
    'sender_name', (select display_name from public.profiles where id = v_uid),
    'sender_avatar', (select avatar_path from public.profiles where id = v_uid),
    'body', v_row.body,
    'created_at', v_row.created_at,
    'mine', true,
    'reply_to', soso.dm_reply_preview(p_reply_to),
    'reactions', '[]'::jsonb,
    'mentions', soso.dm_mentions_json(v_row.id),
    'image_path', v_row.image_path,
    'image_width', v_row.image_width,
    'image_height', v_row.image_height,
    'media_kind', v_row.media_kind,
    'poster_path', v_row.poster_path,
    'duration_ms', v_row.duration_ms,
    'shared_post', soso.shared_post_card(v_row.shared_post_id, v_uid),
    'event_kind', null,
    'event_target_id', null,
    'event_target_name', null,
    'event_text', null
  );
end;
$$;

grant execute on function public.send_dm(uuid, text, uuid, text, integer, integer, uuid, text, text, integer, uuid[]) to authenticated;

-- The 10-argument overload from migration 0047, now superseded. Dropped
-- rather than left in place, matching every previous widening of this same
-- function (0039, 0040, 0044, 0046) -- two callable shapes of "send a
-- message" is two things a future migration has to remember to change.
drop function if exists public.send_dm(uuid, text, uuid, text, integer, integer, uuid, text, text, integer);


-- ----------------------------------------------------------------------------
-- list_dm_messages -- restated from 0047, carrying each row's mentions
-- ----------------------------------------------------------------------------
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
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    perform soso.fail('soso/unauthenticated');
  end if;
  if not soso.dm_thread_visible(p_thread_id, v_uid) then
    perform soso.fail('soso/thread_not_found');
  end if;

  return (
    select coalesce(jsonb_agg(row_json order by created_at asc), '[]'::jsonb)
    from (
      select jsonb_build_object(
        'id', m.id,
        'thread_id', m.thread_id,
        'sender_id', m.sender_id,
        'sender_handle', s.handle,
        'sender_name', s.display_name,
        'sender_avatar', s.avatar_path,
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
        -- Null on an ordinary message, which is how the client tells the two
        -- apart without a second list to merge in.
        'event_kind', m.event_kind,
        'event_target_id', m.event_target_id,
        'event_target_name', et.display_name,
        'event_text', m.event_text,
        'mentions', soso.dm_mentions_json(m.id),
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
      join public.profiles s on s.id = m.sender_id
      left join public.profiles et on et.id = m.event_target_id
      where m.thread_id = p_thread_id
        and not soso.is_blocked_pair(v_uid, m.sender_id)
        and (p_before is null or m.created_at < p_before)
      order by m.created_at desc
      limit least(greatest(coalesce(p_limit, 50), 1), 100)
    ) page
  );
end;
$$;
