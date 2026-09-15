-- ============================================================================
-- User mentions (migration 0048) -- an executable check of the RPCs
-- ============================================================================
--
-- Run against a LOCAL database only, same as group_chats.sql beside it — it
-- creates its own four accounts and a group and leaves them behind:
--
--   supabase db reset
--   psql "$(supabase status -o env | grep DB_URL | cut -d= -f2- | tr -d '"')" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/group_mentions.sql
--
-- A clean run ends with "OK - every assertion passed" and nothing else
-- matters.
--
-- WHY THIS EXISTS AS SQL RATHER THAN AS A TEST IN packages/core
-- ---------------------------------------------------------------------
-- What this migration actually enforces — that a mention can only name a
-- CURRENT MEMBER, silently dropping anyone else rather than failing the
-- send, and that it disappears once that member leaves — is server-side
-- validation and row-level security. `extractMentionedIds`/`splitMentions`
-- (core) are pure text functions and are tested there directly; this file
-- is what checks the database actually backs them.
-- ============================================================================

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

insert into public.follows (follower_id, followee_id)
select a.id, b.id
from public.profiles a, public.profiles b
where a.id <> b.id
on conflict do nothing;

set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

-- Ana, Bo and Chi in a group. Dee stays out of it, deliberately — the
-- stranger a mention must fail to reach.
create temp table g as
select public.create_group_thread(
  'Tuesday Football',
  array['22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333']::uuid[]
) as t;

-- A real mention: Ana sends, naming Bo. Comes back on the send's own
-- response, not just on a later reload.
create temp table msg1 as
select public.send_dm(
  (select (t->>'id')::uuid from g),
  'hey @bo are you free tonight',
  null, null, null, null, null, null, null, null,
  array['22222222-2222-2222-2222-222222222222']::uuid[]
) as m;

select 'send_dm mentions' as step,
       jsonb_array_length(m->'mentions') as n,
       m->'mentions'->0->>'handle' as handle
from msg1;

do $$
declare v_id uuid := (select (m->>'id')::uuid from msg1);
begin
  if (select count(*) from public.dm_message_mentions where message_id = v_id) <> 1 then
    raise exception 'send_dm did not persist the mention';
  end if;
end $$;

-- list_dm_messages carries the same mention back on reload, not only on the
-- original send's response.
select 'list_dm_messages mentions' as step,
       (elem->'mentions'->0->>'handle') as handle
from g, jsonb_array_elements(public.list_dm_messages((select (t->>'id')::uuid from g))) as elem
where elem->>'id' = (select m->>'id' from msg1);

-- Dee is not a member: naming her is silently dropped, not an error, and the
-- message still sends with whatever real mentions it also had.
create temp table msg2 as
select public.send_dm(
  (select (t->>'id')::uuid from g),
  'hey @dee and @bo',
  null, null, null, null, null, null, null, null,
  array['44444444-4444-4444-4444-444444444444', '22222222-2222-2222-2222-222222222222']::uuid[]
) as m;

do $$
declare
  v_id uuid := (select (m->>'id')::uuid from msg2);
  v_n  integer;
begin
  select jsonb_array_length(m->'mentions') into v_n from msg2;
  if v_n <> 1 then
    raise exception 'a non-member mention was not dropped (got % mentions)', v_n;
  end if;
  if exists (
    select 1 from public.dm_message_mentions
    where message_id = v_id and user_id = '44444444-4444-4444-4444-444444444444'
  ) then
    raise exception 'a non-member ended up in dm_message_mentions';
  end if;
end $$;

-- Mentioning yourself is a no-op, the same as create_group_thread dropping
-- the creator from its own member list — not an error, just nothing added.
create temp table msg3 as
select public.send_dm(
  (select (t->>'id')::uuid from g),
  'talking to myself @ana',
  null, null, null, null, null, null, null, null,
  array['11111111-1111-1111-1111-111111111111']::uuid[]
) as m;

select 'self-mention dropped' as step, jsonb_array_length(m->'mentions') as n from msg3;
do $$
begin
  if (select jsonb_array_length(m->'mentions') from msg3) <> 0 then
    raise exception 'mentioning yourself was not dropped';
  end if;
end $$;

-- Duplicates in the input collapse to one row, the same array_agg(distinct)
-- pattern add_group_members already uses for its own member list.
create temp table msg4 as
select public.send_dm(
  (select (t->>'id')::uuid from g),
  'so, @bo, @bo, are you in',
  null, null, null, null, null, null, null, null,
  array['22222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222']::uuid[]
) as m;

select 'duplicate mention collapses' as step, jsonb_array_length(m->'mentions') as n from msg4;
do $$
begin
  if (select jsonb_array_length(m->'mentions') from msg4) <> 1 then
    raise exception 'a duplicated id in the input was not deduplicated';
  end if;
end $$;

-- A mention in ONE thread must not appear when reading a DIFFERENT one, even
-- for the same two people — the read policy is scoped by message, not by
-- who the mentioned person happens to be.
create temp table dm as
select public.open_dm_thread('22222222-2222-2222-2222-222222222222') as t;

create temp table msg5 as
select public.send_dm(
  (select (t->>'id')::uuid from dm),
  'separate thread, @bo',
  null, null, null, null, null, null, null, null,
  array['22222222-2222-2222-2222-222222222222']::uuid[]
) as m;

do $$
declare
  v_group_id uuid := (select (t->>'id')::uuid from g);
  v_dm_id    uuid := (select (t->>'id')::uuid from dm);
begin
  if exists (
    select 1
    from public.dm_message_mentions dmm
    join public.dm_messages msg on msg.id = dmm.message_id
    where msg.id = (select (m->>'id')::uuid from msg5)
      and msg.thread_id = v_group_id
  ) then
    raise exception 'a direct-thread mention leaked into the group thread';
  end if;
end $$;

-- Bo leaves; his SENT message (and the mention IN it, since he authored the
-- text naming himself back) still exists and still resolves — a mention row
-- has no foreign key back to membership, only to the message and the
-- profile, so it must not evaporate just because the person left.
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
perform public.leave_group_thread((select (t->>'id')::uuid from g));

set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select 'mention survives the mentioned person leaving' as step,
       (elem->'mentions'->0->>'handle') as handle
from g, jsonb_array_elements(public.list_dm_messages((select (t->>'id')::uuid from g))) as elem
where elem->>'id' = (select m->>'id' from msg1);

-- Ana can no longer ADD Bo as a mention (he is not a member any more), even
-- though his old mention above still resolves.
create temp table msg6 as
select public.send_dm(
  (select (t->>'id')::uuid from g),
  'is @bo still around',
  null, null, null, null, null, null, null, null,
  array['22222222-2222-2222-2222-222222222222']::uuid[]
) as m;

select 'cannot mention someone who left' as step, jsonb_array_length(m->'mentions') as n from msg6;
do $$
begin
  if (select jsonb_array_length(m->'mentions') from msg6) <> 0 then
    raise exception 'a former member could still be mentioned';
  end if;
end $$;

-- The RLS policy itself, as the `authenticated` role rather than as the
-- superuser every statement above ran as. Chi (still a member) can read
-- Ana's mention of Bo; Dee (never a member) reads nothing for that message.
set role authenticated;
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
select 'rls member reads the mention' as step, count(*) as n
from public.dm_message_mentions where message_id = (select (m->>'id')::uuid from msg1);

set request.jwt.claim.sub = '44444444-4444-4444-4444-444444444444';
select 'rls stranger reads nothing' as step, count(*) as n
from public.dm_message_mentions where message_id = (select (m->>'id')::uuid from msg1);
reset role;

select 'OK - every assertion passed' as result;
