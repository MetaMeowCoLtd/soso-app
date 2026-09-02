-- ============================================================================
-- 0015  Shared chat
-- ============================================================================
--
-- One global room, not scoped per area — "for all users" was read literally
-- rather than folded into the existing hyperlocal cell model. That is a
-- genuine departure from how everything else in this schema works, and
-- worth being explicit about rather than quietly assuming: if what was
-- actually wanted is a per-neighbourhood chat, this is the wrong shape for
-- it and would need a room_id column and per-cell scoping instead.
--
-- WHY THIS NEEDED GUARDRAILS THIS APP DIDN'T PREVIOUSLY HAVE
-- -------------------------------------------------------------
-- Every account in this schema is anonymous sign-in with no phone
-- verification yet (see the README's own known limitations). A single
-- open, real-time, globally-shared text channel is a meaningfully larger
-- abuse surface than anything else here: posts are location-bound and
-- expire, votes are binary, but chat is free text with no moderation
-- workflow behind it. This migration does not solve that — there is still
-- no admin review queue, matching the same gap moderation_reports already
-- has — but it does add the two guardrails that are actually buildable at
-- the schema level: a rate limit (send_chat_message) and a way to flag
-- something for later review (report_chat_message), both following the
-- exact pattern report_post already established.
-- ============================================================================

create table public.chat_messages (
  id          uuid primary key default extensions.gen_random_uuid(),
  author_id   uuid not null references public.profiles (id) on delete cascade,
  body        text not null check (length(trim(body)) between 1 and 500),
  created_at  timestamptz not null default now()
);

create index chat_messages_created_idx on public.chat_messages (created_at desc);

alter table public.chat_messages enable row level security;

-- Readable by anyone signed in — there is no per-message audience here,
-- unlike posts. Writes only ever go through send_chat_message below.
create policy chat_messages_read on public.chat_messages
  for select to authenticated
  using (true);

revoke all on public.chat_messages from anon, authenticated;
grant select on public.chat_messages to authenticated;


-- ----------------------------------------------------------------------------
-- chat_message_reports
-- ----------------------------------------------------------------------------
-- Deliberately a separate table from moderation_reports rather than a
-- shared polymorphic one (a post_id/message_id pair with a nullable
-- foreign key each). A single reports table covering two different content
-- types needs constraints ensuring exactly one of the two ids is set, and
-- every future addition (chat message, future comment, whatever comes
-- next) would repeat that same widening. Two small, single-purpose tables
-- are easier to reason about than one table trying to cover every kind of
-- flaggable content in advance.
-- ----------------------------------------------------------------------------
create table public.chat_message_reports (
  id          uuid primary key default extensions.gen_random_uuid(),
  message_id  uuid not null references public.chat_messages (id) on delete cascade,
  reported_by uuid not null references public.profiles (id) on delete cascade,
  reason      text not null,
  created_at  timestamptz not null default now(),
  unique (message_id, reported_by)
);

alter table public.chat_message_reports enable row level security;

create policy chat_message_reports_read_own on public.chat_message_reports
  for select to authenticated
  using (reported_by = auth.uid());

revoke all on public.chat_message_reports from anon, authenticated;
grant select on public.chat_message_reports to authenticated;


-- ----------------------------------------------------------------------------
-- send_chat_message
-- ----------------------------------------------------------------------------
create or replace function public.send_chat_message(p_body text)
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

  insert into public.chat_messages (author_id, body)
  values (v_uid, v_body)
  returning * into v_row;

  select * into v_author from public.profiles where id = v_uid;

  return jsonb_build_object(
    'id', v_row.id,
    'body', v_row.body,
    'created_at', v_row.created_at,
    'author_id', v_row.author_id,
    'author_handle', v_author.handle,
    'author_name', v_author.display_name,
    'mine', true
  );
end;
$$;

grant execute on function public.send_chat_message(text) to authenticated;


-- ----------------------------------------------------------------------------
-- list_recent_chat_messages
-- ----------------------------------------------------------------------------
-- Author handle/display name joined in here rather than requiring a
-- separate per-message profile lookup client-side — chat can render
-- dozens of messages at once, and N+1 profile fetches for that would be a
-- real cost this avoids for free at the database layer.
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
      'mine', m.author_id = auth.uid()
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
-- delete_chat_message — author-only
-- ----------------------------------------------------------------------------
create or replace function public.delete_chat_message(p_message_id uuid)
  returns void
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    perform soso.fail('soso/unauthenticated');
  end if;
  delete from public.chat_messages
  where id = p_message_id and author_id = auth.uid();
end;
$$;

grant execute on function public.delete_chat_message(uuid) to authenticated;


-- ----------------------------------------------------------------------------
-- report_chat_message
-- ----------------------------------------------------------------------------
create or replace function public.report_chat_message(
  p_message_id uuid,
  p_reason     text
)
  returns void
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    perform soso.fail('soso/unauthenticated');
  end if;
  if not exists (select 1 from public.chat_messages where id = p_message_id) then
    perform soso.fail('soso/post_not_found');
  end if;

  insert into public.chat_message_reports (message_id, reported_by, reason)
  values (p_message_id, v_uid, coalesce(nullif(trim(p_reason), ''), 'other'))
  on conflict (message_id, reported_by) do nothing;
end;
$$;

grant execute on function public.report_chat_message(uuid, text) to authenticated;


-- ----------------------------------------------------------------------------
-- Realtime
-- ----------------------------------------------------------------------------
-- Matches the existing posts/follows pattern from migration 0012 exactly:
-- the client treats an event on this publication as nothing more than "go
-- refetch," never as a payload to trust directly. For chat specifically
-- that distinction matters less than it does for posts (nothing here is
-- audience-restricted — RLS already allows any authenticated read of every
-- row), but using the same signal-then-refetch shape everywhere is worth
-- more than the small efficiency a trust-the-payload shortcut would save
-- here.
alter publication supabase_realtime add table public.chat_messages;
