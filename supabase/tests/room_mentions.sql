-- ============================================================================
-- User mentions in the shared room (migration 0049) -- an executable check
-- ============================================================================
--
-- Run against a LOCAL database only, same as group_mentions.sql beside it —
-- it creates its own four accounts and leaves them behind:
--
--   supabase db reset
--   psql "$(supabase status -o env | grep DB_URL | cut -d= -f2- | tr -d '"')" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/room_mentions.sql
--
-- A clean run ends with "OK - every assertion passed" and nothing else
-- matters.
--
-- WHY THIS IS A SEPARATE FILE FROM group_mentions.sql
-- ---------------------------------------------------------------------
-- The two migrations validate a mention against a different boundary
-- (thread membership vs. mutual follow) and read it back through a
-- differently-scoped RLS policy (member-only vs. anyone signed in) — see
-- migration 0049's own header for why. Those two differences are exactly
-- what this file exists to exercise; the parts that are identical (a
-- mention is dropped, not rejected, when it does not resolve; duplicates
-- collapse; a persisted mention survives the relationship it was validated
-- against later breaking) are proven the same way group_mentions.sql proves
-- them for a group, just against `chat_message_mentions` instead of
-- `dm_message_mentions`.
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

-- Ana and Bo follow each other -- a mutual follow, the boundary this
-- migration actually checks.
insert into public.follows (follower_id, followee_id) values
  ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'),
  ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111');

-- Ana follows Chi, but Chi never follows back -- one-sided, deliberately,
-- so there is a real "not a mutual follow" case to drop a mention against
-- rather than only "never met at all" (Dee, below).
insert into public.follows (follower_id, followee_id) values
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333');

-- Dee has no relationship with anybody -- the total stranger.

set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

-- A real mention: Ana posts to the room, naming Bo. Comes back on the send's
-- own response, not just on a later reload.
create temp table msg1 as
select public.send_chat_message(
  'hey @bo are you around',
  null, null, null, null, null, null, null, null,
  array['22222222-2222-2222-2222-222222222222']::uuid[]
) as m;

select 'send_chat_message mentions' as step,
       jsonb_array_length(m->'mentions') as n,
       m->'mentions'->0->>'handle' as handle
from msg1;

do $$
declare v_id uuid := (select (m->>'id')::uuid from msg1);
begin
  if (select count(*) from public.chat_message_mentions where message_id = v_id) <> 1 then
    raise exception 'send_chat_message did not persist the mention';
  end if;
end $$;

-- list_recent_chat_messages carries the same mention back on reload, not
-- only on the original send's response.
select 'list_recent_chat_messages mentions' as step,
       (elem->'mentions'->0->>'handle') as handle
from jsonb_array_elements(public.list_recent_chat_messages(null, 50)) as elem
where elem->>'id' = (select m->>'id' from msg1);

-- Chi is not a mutual follow (only one-sided): naming her is silently
-- dropped, not an error, and the message still sends with whatever real
-- mentions it also had.
create temp table msg2 as
select public.send_chat_message(
  'hey @chi and @bo',
  null, null, null, null, null, null, null, null,
  array['33333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222']::uuid[]
) as m;

do $$
declare
  v_id uuid := (select (m->>'id')::uuid from msg2);
  v_n  integer;
begin
  select jsonb_array_length(m->'mentions') into v_n from msg2;
  if v_n <> 1 then
    raise exception 'a one-sided-follow mention was not dropped (got % mentions)', v_n;
  end if;
  if exists (
    select 1 from public.chat_message_mentions
    where message_id = v_id and user_id = '33333333-3333-3333-3333-333333333333'
  ) then
    raise exception 'a non-mutual follow ended up in chat_message_mentions';
  end if;
end $$;

-- Dee -- a total stranger, not merely one-sided -- is dropped the same way.
create temp table msg2b as
select public.send_chat_message(
  'is @dee even here',
  null, null, null, null, null, null, null, null,
  array['44444444-4444-4444-4444-444444444444']::uuid[]
) as m;

select 'stranger mention dropped' as step, jsonb_array_length(m->'mentions') as n from msg2b;
do $$
begin
  if (select jsonb_array_length(m->'mentions') from msg2b) <> 0 then
    raise exception 'a total stranger could be mentioned';
  end if;
end $$;

-- Mentioning yourself is a no-op, the same as migration 0048's DM/group
-- version -- not an error, just nothing added.
create temp table msg3 as
select public.send_chat_message(
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
-- pattern send_dm already uses for the same purpose.
create temp table msg4 as
select public.send_chat_message(
  'so, @bo, @bo, you around',
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

-- A mention made in a DM with Bo must not appear in chat_message_mentions,
-- and vice versa -- the two tables migration 0049's header argues for
-- instead of one polymorphic one are actually isolated, not just declared
-- that way.
create temp table dm as
select public.open_dm_thread('22222222-2222-2222-2222-222222222222') as t;

create temp table dm_msg as
select public.send_dm(
  (select (t->>'id')::uuid from dm),
  'in our dm, @bo',
  null, null, null, null, null, null, null, null,
  array['22222222-2222-2222-2222-222222222222']::uuid[]
) as m;

do $$
declare v_id uuid := (select (m->>'id')::uuid from dm_msg);
begin
  if exists (select 1 from public.chat_message_mentions where message_id = v_id) then
    raise exception 'a DM mention leaked into chat_message_mentions';
  end if;
end $$;

do $$
declare v_id uuid := (select (m->>'id')::uuid from msg1);
begin
  if exists (select 1 from public.dm_message_mentions where message_id = v_id) then
    raise exception 'a room mention leaked into dm_message_mentions';
  end if;
end $$;

-- Bo unfollows Ana, breaking the mutual follow. His earlier mention (msg1)
-- still exists and still resolves -- a mention row has no foreign key back
-- to the relationship, only to the message and the profile, so it must not
-- evaporate just because the relationship that validated it later ended.
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
delete from public.follows
where follower_id = '22222222-2222-2222-2222-222222222222'
  and followee_id = '11111111-1111-1111-1111-111111111111';

set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select 'mention survives the mutual follow later breaking' as step,
       (elem->'mentions'->0->>'handle') as handle
from jsonb_array_elements(public.list_recent_chat_messages(null, 50)) as elem
where elem->>'id' = (select m->>'id' from msg1);

-- Ana can no longer ADD Bo as a mention (they are not mutual any more), even
-- though his old mention above still resolves.
create temp table msg5 as
select public.send_chat_message(
  'is @bo still around',
  null, null, null, null, null, null, null, null,
  array['22222222-2222-2222-2222-222222222222']::uuid[]
) as m;

select 'cannot mention someone no longer mutual' as step, jsonb_array_length(m->'mentions') as n from msg5;
do $$
begin
  if (select jsonb_array_length(m->'mentions') from msg5) <> 0 then
    raise exception 'a broken mutual follow could still be mentioned';
  end if;
end $$;

-- The RLS policy itself, as the `authenticated` role rather than as the
-- superuser every statement above ran as -- and the interesting case here
-- is the OPPOSITE of the DM version's: Dee, a total stranger who was never
-- mutual with anybody and could never have been validly mentioned, can
-- still READ this mention. `chat_message_mentions_read` is `using (true)`,
-- matching `chat_messages` and `chat_message_reactions` themselves -- the
-- room has never had a per-row audience, and a mention inside it is not
-- where one starts.
set role authenticated;
set request.jwt.claim.sub = '44444444-4444-4444-4444-444444444444';
select 'rls: even a stranger reads a room mention' as step, count(*) as n
from public.chat_message_mentions where message_id = (select (m->>'id')::uuid from msg1);
do $$
begin
  if (
    select count(*) from public.chat_message_mentions
    where message_id = (select (m->>'id')::uuid from msg1)
  ) <> 1 then
    raise exception 'chat_message_mentions is no longer readable by every signed-in user';
  end if;
end $$;
reset role;

select 'OK - every assertion passed' as result;
