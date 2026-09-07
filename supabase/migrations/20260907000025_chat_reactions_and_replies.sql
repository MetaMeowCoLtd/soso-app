-- ============================================================================
-- 0025  Chat reactions and replies
-- ============================================================================
--
-- Two additions to shared chat (migration 0015), both purely additive to its
-- existing shape:
--
--   - reply_to_id on chat_messages, so a message can quote another one
--     (the Instagram/Threads-DM "replying to" preview), enforced through
--     send_chat_message rather than left open to a raw insert. ON DELETE SET
--     NULL means a reply to a since-deleted message just loses its quote
--     instead of the reply itself becoming unreadable or orphaned.
--
--   - chat_message_reactions: one emoji tapback per (message, user), the
--     same shape iMessage/Instagram DM reactions use. toggle_chat_reaction
--     is the only way to write it — tapping a new emoji on a message you've
--     already reacted to replaces your reaction, tapping the same one again
--     clears it, matching that same precedent.
--
-- Both read paths (send_chat_message's own return value, and
-- list_recent_chat_messages) are widened to carry this inline, the same
-- choice list_recent_chat_messages already made for author handle/name in
-- 0015 — a chat rendering dozens of messages should not need a second round
-- trip per message to show its reply preview or reaction pills.
-- ============================================================================

alter table public.chat_messages
  add column reply_to_id uuid references public.chat_messages (id) on delete set null;

create table public.chat_message_reactions (
  message_id  uuid not null references public.chat_messages (id) on delete cascade,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  emoji       text not null check (length(emoji) between 1 and 16),
  created_at  timestamptz not null default now(),
  primary key (message_id, user_id)
);

create index chat_message_reactions_message_idx on public.chat_message_reactions (message_id);

alter table public.chat_message_reactions enable row level security;

-- Same visibility as chat_messages itself (migration 0015): no per-row
-- audience here, readable by anyone signed in.
create policy chat_message_reactions_read on public.chat_message_reactions
  for select to authenticated
  using (true);

revoke all on public.chat_message_reactions from anon, authenticated;
grant select on public.chat_message_reactions to authenticated;


-- ----------------------------------------------------------------------------
-- soso.chat_reply_preview
-- ----------------------------------------------------------------------------
-- Shared by send_chat_message and list_recent_chat_messages below rather
-- than duplicated inline in both — the same reasoning as soso.can_see_post
-- being one predicate every post read path calls. Returns null for both "no
-- reply" (p_id is null) and "replied-to message is gone" (the row lookup
-- finds nothing, which reply_to_id's own ON DELETE SET NULL means only
-- happens in the instant between the parent's delete and this column
-- following it) -- callers don't need to tell those two apart.
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
    'author_name', p.display_name
  )
  from public.chat_messages m
  join public.profiles p on p.id = m.author_id
  where p_id is not null and m.id = p_id;
$$;


-- ----------------------------------------------------------------------------
-- send_chat_message — now takes an optional reply target
-- ----------------------------------------------------------------------------
create or replace function public.send_chat_message(p_body text, p_reply_to uuid default null)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = public, extensions, pg_temp
as $$
declare
  v_uid    uuid := auth.uid();
  v_body   text := trim(coalesce(p_body, ''));
  v_recent integer;
  v_row    public.chat_messages;
  v_author public.profiles;
begin
  if v_uid is null then
    perform soso.fail('soso/unauthenticated');
  end if;
  if length(v_body) = 0 then
    perform soso.fail('soso/empty_message');
  end if;
  if length(v_body) > 500 then
    perform soso.fail('soso/message_too_long');
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

  insert into public.chat_messages (author_id, body, reply_to_id)
  values (v_uid, v_body, p_reply_to)
  returning * into v_row;

  select * into v_author from public.profiles where id = v_uid;

  return jsonb_build_object(
    'id', v_row.id,
    'body', v_row.body,
    'created_at', v_row.created_at,
    'author_id', v_row.author_id,
    'author_handle', v_author.handle,
    'author_name', v_author.display_name,
    'mine', true,
    'reply_to', soso.chat_reply_preview(p_reply_to),
    'reactions', '[]'::jsonb
  );
end;
$$;

grant execute on function public.send_chat_message(text, uuid) to authenticated;


-- ----------------------------------------------------------------------------
-- list_recent_chat_messages — now also reports reply_to and reactions
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
      'mine', m.author_id = auth.uid(),
      'reply_to', soso.chat_reply_preview(m.reply_to_id),
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

grant execute on function public.list_recent_chat_messages(timestamptz, integer) to authenticated;


-- ----------------------------------------------------------------------------
-- toggle_chat_reaction
-- ----------------------------------------------------------------------------
-- One reaction per (message, user): tapping a different emoji replaces
-- your existing one, tapping your existing one again clears it. Everything
-- the client needs to render the result (per-emoji counts, and whether the
-- caller is among them) comes back through list_recent_chat_messages on the
-- realtime refetch this triggers, not from this function's own return
-- value — matching the signal-then-refetch contract every other write in
-- this app follows.
-- ----------------------------------------------------------------------------
create or replace function public.toggle_chat_reaction(p_message_id uuid, p_emoji text)
  returns void
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_uid      uuid := auth.uid();
  v_emoji    text := trim(coalesce(p_emoji, ''));
  v_existing text;
begin
  if v_uid is null then
    perform soso.fail('soso/unauthenticated');
  end if;
  if length(v_emoji) = 0 or length(v_emoji) > 16 then
    perform soso.fail('soso/invalid_reaction');
  end if;
  if not exists (select 1 from public.chat_messages where id = p_message_id) then
    perform soso.fail('soso/message_not_found');
  end if;

  select emoji into v_existing
  from public.chat_message_reactions
  where message_id = p_message_id and user_id = v_uid;

  if v_existing is null then
    insert into public.chat_message_reactions (message_id, user_id, emoji)
    values (p_message_id, v_uid, v_emoji);
  elsif v_existing = v_emoji then
    delete from public.chat_message_reactions
    where message_id = p_message_id and user_id = v_uid;
  else
    update public.chat_message_reactions
    set emoji = v_emoji, created_at = now()
    where message_id = p_message_id and user_id = v_uid;
  end if;
end;
$$;

grant execute on function public.toggle_chat_reaction(uuid, text) to authenticated;


-- ----------------------------------------------------------------------------
-- Realtime
-- ----------------------------------------------------------------------------
-- chat_message_reactions' primary key (message_id, user_id) already covers
-- every column chat_message_reactions_read's `using (true)` needs, so the
-- default replica identity (primary key) is enough — unlike posts/post_media
-- in migration 0012, this table needs no REPLICA IDENTITY FULL.
alter publication supabase_realtime add table public.chat_message_reactions;
