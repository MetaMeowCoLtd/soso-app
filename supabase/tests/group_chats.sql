-- ============================================================================
-- Group chats (migration 0047) -- an executable check of the RPCs
-- ============================================================================
--
-- Run against a LOCAL database only. It creates four accounts and a couple of
-- conversations and leaves them behind, so it is a check you run after
-- `supabase db reset`, not something to point at anything real:
--
--   supabase db reset
--   psql "$(supabase status -o env | grep DB_URL | cut -d= -f2- | tr -d '"')" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/group_chats.sql
--
-- It prints a row per step and raises on the first thing that is wrong, so a
-- clean run ends with "OK - every assertion passed" and nothing else matters.
--
-- WHY THIS EXISTS AS SQL RATHER THAN AS A TEST IN packages/core
-- ---------------------------------------------------------------------
-- Everything it checks is enforced in the database: the member cap, who may
-- remove whom, ownership passing on when the owner leaves, a system event
-- being un-unsendable, and the row-level security that decides what a
-- non-member sees. None of that is reachable from the gateway's own tests,
-- which run against no database at all. `soso.dm_can_message` is stubbed to
-- true in a fresh local database only insofar as the four accounts here
-- follow each other -- see the follows inserted below.
--
-- The accounts write directly into `profiles` and `follows` rather than going
-- through sign-up, because this is testing the conversation RPCs and not the
-- ones that make an account.
-- ============================================================================

-- `profiles.id` references `auth.users`, so the accounts have to exist there
-- first. Only the id is ours to choose; everything else on that table has a
-- default or is nullable in a local stack.
insert into auth.users (id, email)
values ('11111111-1111-1111-1111-111111111111', 'ana@example.test'),
       ('22222222-2222-2222-2222-222222222222', 'bo@example.test'),
       ('33333333-3333-3333-3333-333333333333', 'chi@example.test'),
       ('44444444-4444-4444-4444-444444444444', 'dee@example.test')
on conflict do nothing;

insert into public.profiles (id, handle, display_name) values
  ('11111111-1111-1111-1111-111111111111', 'ana', 'Ana'),
  ('22222222-2222-2222-2222-222222222222', 'bo',  'Bo'),
  ('33333333-3333-3333-3333-333333333333', 'chi', 'Chi'),
  ('44444444-4444-4444-4444-444444444444', 'dee', 'Dee');

-- Everyone follows everyone, in both directions, because `soso.dm_can_message`
-- is re-checked on every add and every send and none of this is reachable
-- without it. Dee included: Dee is the person added and then removed further
-- down, and is the "stranger" only in the sense of not being in the group.
insert into public.follows (follower_id, followee_id)
select a.id, b.id
from public.profiles a, public.profiles b
where a.id <> b.id
on conflict do nothing;

set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

-- A direct thread still opens, and still returns one row per pair.
select 'open_dm_thread' as step,
       (public.open_dm_thread('22222222-2222-2222-2222-222222222222')->>'kind') as kind;
select 'open_dm_thread twice' as step,
       count(*) as threads from public.dm_threads where kind = 'direct';
do $$
begin
  perform public.open_dm_thread('22222222-2222-2222-2222-222222222222');
  if (select count(*) from public.dm_threads where kind = 'direct') <> 1 then
    raise exception 'open_dm_thread created a second thread for the same pair';
  end if;
  if (select count(*) from public.dm_thread_members) <> 2 then
    raise exception 'direct thread did not get exactly two member rows';
  end if;
end $$;

-- One other person is not a group.
do $$
begin
  begin
    perform public.create_group_thread('Nope', array['22222222-2222-2222-2222-222222222222']::uuid[]);
    raise exception 'create_group_thread accepted a single member';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'soso/group_too_small' then raise; end if;
  end;
end $$;

-- The real thing.
create temp table g as
select public.create_group_thread(
  '  Tuesday Football  ',
  array['22222222-2222-2222-2222-222222222222',
        '33333333-3333-3333-3333-333333333333',
        '22222222-2222-2222-2222-222222222222']::uuid[],
  '11111111-1111-1111-1111-111111111111/abc.jpg'
) as t;

select 'group' as step,
       t->>'kind' as kind,
       t->>'title' as title,
       t->>'my_role' as my_role,
       t->>'member_count' as member_count,
       jsonb_array_length(t->'members') as members_listed,
       t->>'last_event_kind' as last_event,
       t->>'unread' as unread
from g;

do $$
declare v_id uuid := (select (t->>'id')::uuid from g);
begin
  if (select count(*) from public.dm_thread_members where thread_id = v_id) <> 3 then
    raise exception 'group did not get three members (duplicate not deduped?)';
  end if;
  if (select title from public.dm_threads where id = v_id) <> 'Tuesday Football' then
    raise exception 'title was not trimmed';
  end if;
end $$;

-- Sending, replying, reacting, reading.
do $$
declare
  v_id  uuid := (select (t->>'id')::uuid from g);
  v_msg jsonb;
begin
  v_msg := public.send_dm(v_id, 'kickoff at seven');
  if (v_msg->>'sender_name') <> 'Ana' then
    raise exception 'send_dm did not carry the sender name';
  end if;

  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
  perform public.send_dm(v_id, 'on my way', (v_msg->>'id')::uuid);
  perform public.toggle_dm_reaction((v_msg->>'id')::uuid, U&'\+01F44D');
  perform public.mark_dm_read(v_id);
end $$;

set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

select 'messages' as step,
       jsonb_array_length(public.list_dm_messages((select (t->>'id')::uuid from g))) as n
from g;

select 'reply carries a name' as step,
       m->'reply_to'->>'sender_name' as quoted_from
from g, jsonb_array_elements(public.list_dm_messages((select (t->>'id')::uuid from g))) as m
where m->'reply_to' is not null and m->'reply_to' <> 'null'::jsonb;

select 'read state' as step, jsonb_array_length(public.dm_thread_read_state((select (t->>'id')::uuid from g))) as readers from g;

select 'inbox' as step, jsonb_array_length(public.list_dm_threads()) as rows;

select 'inbox preview' as step,
       r->>'kind' as kind, r->>'last_sender_name' as who, r->>'last_body' as body
from jsonb_array_elements(public.list_dm_threads()) as r
where r->>'kind' = 'group';

-- Adding, renaming, the cap, and who may remove.
do $$
declare v_id uuid := (select (t->>'id')::uuid from g);
begin
  perform public.add_group_members(v_id, array['44444444-4444-4444-4444-444444444444']::uuid[]);
  if (select count(*) from public.dm_thread_members where thread_id = v_id) <> 4 then
    raise exception 'add_group_members did not add';
  end if;

  -- Idempotent: already a member, so no second row and no second event.
  perform public.add_group_members(v_id, array['44444444-4444-4444-4444-444444444444']::uuid[]);
  if (select count(*) from public.dm_messages where thread_id = v_id and event_kind = 'added') <> 1 then
    raise exception 'adding an existing member posted a duplicate event';
  end if;

  perform public.rename_group_thread(v_id, 'Wednesday Football');
  -- No-op rename posts nothing.
  perform public.rename_group_thread(v_id, 'Wednesday Football');
  if (select count(*) from public.dm_messages where thread_id = v_id and event_kind = 'renamed') <> 1 then
    raise exception 'a no-op rename posted an event';
  end if;

  -- A member who is not the owner may not remove anyone.
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
  begin
    perform public.remove_group_member(v_id, '44444444-4444-4444-4444-444444444444');
    raise exception 'a non-owner removed a member';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'soso/owner_only' then raise; end if;
  end;

  -- The owner may.
  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
  perform public.remove_group_member(v_id, '44444444-4444-4444-4444-444444444444');
  if soso.dm_is_member(v_id, '44444444-4444-4444-4444-444444444444') then
    raise exception 'remove_group_member did not remove';
  end if;
end $$;

-- Leaving: the owner goes, the longest-standing member is promoted.
do $$
declare v_id uuid := (select (t->>'id')::uuid from g);
begin
  perform public.leave_group_thread(v_id);
  if soso.dm_is_member(v_id, '11111111-1111-1111-1111-111111111111') then
    raise exception 'leave_group_thread did not remove the leaver';
  end if;
  if (select count(*) from public.dm_thread_members where thread_id = v_id and role = 'owner') <> 1 then
    raise exception 'ownership was not handed on';
  end if;

  -- The last member out deletes the conversation.
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
  perform public.leave_group_thread(v_id);
  perform set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', false);
  perform public.leave_group_thread(v_id);
  if exists (select 1 from public.dm_threads where id = v_id) then
    raise exception 'the last member leaving did not delete the thread';
  end if;
end $$;

-- A system row is not deletable, and not reportable.
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
create temp table g2 as
select public.create_group_thread('Second', array['22222222-2222-2222-2222-222222222222',
                                                  '33333333-3333-3333-3333-333333333333']::uuid[]) as t;
do $$
declare
  v_id  uuid := (select (t->>'id')::uuid from g2);
  v_evt uuid := (select id from public.dm_messages where thread_id = v_id and event_kind is not null limit 1);
begin
  perform public.delete_dm_message(v_evt);
  if not exists (select 1 from public.dm_messages where id = v_evt) then
    raise exception 'a system event was unsent';
  end if;
  begin
    perform public.report_dm_message(v_evt, 'spam');
    raise exception 'a system event was reported';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'soso/message_not_found' then raise; end if;
  end;
  begin
    perform public.toggle_dm_reaction(v_evt, U&'\+01F44D');
    raise exception 'a system event was reacted to';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'soso/message_not_found' then raise; end if;
  end;
end $$;

-- A stranger sees nothing.
set request.jwt.claim.sub = '44444444-4444-4444-4444-444444444444';
select 'stranger inbox' as step, jsonb_array_length(public.list_dm_threads()) as rows;
do $$
begin
  begin
    perform public.list_dm_messages((select (t->>'id')::uuid from g2));
    raise exception 'a non-member read a group';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'soso/thread_not_found' then raise; end if;
  end;
  begin
    perform public.send_dm((select (t->>'id')::uuid from g2), 'hello');
    raise exception 'a non-member posted to a group';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'soso/thread_not_found' then raise; end if;
  end;
  if public.may_read_dm_thread((select (t->>'id')::uuid from g2)) then
    raise exception 'a non-member may read group attachments';
  end if;
end $$;

-- The RLS policies themselves, as the `authenticated` role rather than as the
-- superuser every statement above ran as. This is the half that cannot be
-- checked from the client at all: the RPCs are SECURITY DEFINER and therefore
-- prove nothing about what a direct table read is allowed to see.
set role authenticated;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select 'rls member sees thread' as step, count(*) as n from public.dm_threads where kind = 'group';
select 'rls member sees messages' as step, count(*) as n from public.dm_messages;
select 'rls member sees membership' as step, count(*) as n from public.dm_thread_members;
set request.jwt.claim.sub = '44444444-4444-4444-4444-444444444444';
select 'rls stranger sees threads' as step, count(*) as n from public.dm_threads;
select 'rls stranger sees messages' as step, count(*) as n from public.dm_messages;
select 'rls stranger sees membership' as step, count(*) as n from public.dm_thread_members;
reset role;

select 'OK - every assertion passed' as result;
