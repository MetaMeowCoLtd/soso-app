-- ============================================================================
-- 0049  User mentions in the shared room
-- ============================================================================
--
-- The same feature migration 0048 built for DMs and groups, extended to the
-- one conversation that was not a `dm_threads` row at all: the global public
-- room (migration 0015). Requested separately, immediately after 0048
-- shipped, once it became clear "mentions" meant the room too and not only a
-- group.
--
-- WHY THIS COULD NOT JUST REUSE dm_message_mentions
-- ---------------------------------------------------------------------
-- A mention row references the message it was made in, and the room's
-- messages live in `chat_messages`, a different table with a different
-- primary key space from `dm_messages`. `dm_message_mentions.message_id`
-- already has a foreign key into `dm_messages`; widening it to accept
-- either table would need a polymorphic reference (a nullable FK per table,
-- with a constraint ensuring exactly one is set) for the sake of avoiding
-- one small table that is, structurally, the exact question this schema
-- already answers straightforwardly elsewhere for post reports versus chat
-- reports (migration 0015's own comment on `chat_message_reports` makes the
-- identical argument against a shared polymorphic reports table). Two small
-- tables, one per message table, are easier to reason about.
--
-- WHO CAN BE MENTIONED IS A DIFFERENT QUESTION HERE, AND HAS TO BE
-- ---------------------------------------------------------------------
-- A DM/group mention is validated against THREAD MEMBERSHIP, because a
-- thread has membership to check. The room does not: migration 0015 made it
-- global on purpose, readable by anyone signed in, with no such thing as
-- "the people in this conversation" to bound a mention against. Validating
-- against nothing (accepting any user id) would let a mention — and the
-- push notification it sends — reach a total stranger who has never
-- interacted with the sender at all, which is exactly the unsolicited-
-- contact problem `soso.dm_can_message` exists to prevent for messaging in
-- general.
--
-- The boundary used here is `soso.is_mutual_follow(sender, target)`: the
-- same "you follow each other" relationship that already gates opening a
-- DM. It is deliberately NOT `soso.dm_can_message`, which also checks
-- blocks — the room's own read policy has never filtered by block at all
-- (`chat_messages_read` is `using (true)`, unconditionally, since migration
-- 0015), so a mention validated more strictly than the room's own messages
-- already are would be a stranger kind of inconsistency than the one it is
-- trying to avoid. A block does nothing to a room message today; a mention
-- inside one is not the place to quietly start.
-- ============================================================================

create table public.chat_message_mentions (
  message_id uuid not null references public.chat_messages (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (message_id, user_id)
);

create index chat_message_mentions_user_idx on public.chat_message_mentions (user_id, created_at desc);

alter table public.chat_message_mentions enable row level security;

-- Same visibility as chat_messages and chat_message_reactions themselves:
-- no per-row audience, readable by anyone signed in.
create policy chat_message_mentions_read on public.chat_message_mentions
  for select to authenticated
  using (true);

revoke all on public.chat_message_mentions from anon, authenticated;
grant select on public.chat_message_mentions to authenticated;


-- ----------------------------------------------------------------------------
-- soso.chat_mentions_json -- one room message's mentions, as the client wants
-- ----------------------------------------------------------------------------
-- Identical in shape to soso.dm_mentions_json (migration 0048) and kept as a
-- separate function rather than a shared one taking a table name as an
-- argument: a dynamic FROM clause needs `execute format(...)`, which turns a
-- three-line SQL function into dynamic SQL for the sake of not writing the
-- same three lines twice.
-- ----------------------------------------------------------------------------
create or replace function soso.chat_mentions_json(p_message_id uuid)
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
               order by cmm.created_at
             )
      from public.chat_message_mentions cmm
      join public.profiles p on p.id = cmm.user_id
      where cmm.message_id = p_message_id
    ),
    '[]'::jsonb
  );
$$;


-- ----------------------------------------------------------------------------
-- send_chat_message -- restated from 0046, gaining p_mentioned_user_ids
-- ----------------------------------------------------------------------------
create or replace function public.send_chat_message(
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
  v_row       public.chat_messages;
  v_author    public.profiles;
  v_mentioned uuid[];
  v_mention   uuid;
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

  -- Silently dropped rather than rejected, the same "fewer mentions, not a
  -- failed message" choice migration 0048 makes for a group: the client
  -- extracted these from "@handle" text it matched against the SENDER'S own
  -- friends list, so the only way one of these is not a mutual follow is a
  -- race (an unfollow between the last keystroke and Send) or a client that
  -- did not bother checking.
  select array_agg(distinct id) into v_mentioned
  from unnest(coalesce(p_mentioned_user_ids, '{}'::uuid[])) as id
  where id is not null
    and id <> v_uid
    and soso.is_mutual_follow(v_uid, id);

  v_mentioned := coalesce(v_mentioned, '{}'::uuid[]);

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

  if array_length(v_mentioned, 1) > 0 then
    foreach v_mention in array v_mentioned loop
      insert into public.chat_message_mentions (message_id, user_id)
      values (v_row.id, v_mention);
    end loop;
  end if;

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
    'mentions', soso.chat_mentions_json(v_row.id),
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

grant execute on function public.send_chat_message(text, uuid, text, integer, integer, uuid, text, text, integer, uuid[]) to authenticated;

-- The 9-argument overload from migration 0046, now superseded. Dropped
-- rather than left in place, matching every previous widening of this same
-- function (0040, 0044).
drop function if exists public.send_chat_message(text, uuid, text, integer, integer, uuid, text, text, integer);


-- ----------------------------------------------------------------------------
-- list_recent_chat_messages -- restated from 0045, carrying each row's mentions
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
      'media_kind', m.media_kind,
      'poster_path', m.poster_path,
      'duration_ms', m.duration_ms,
      'shared_post', soso.shared_post_card(m.shared_post_id, auth.uid()),
      'mentions', soso.chat_mentions_json(m.id),
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
