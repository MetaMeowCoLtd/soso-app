-- ============================================================================
-- 0047  Group chats
-- ============================================================================
--
-- Instagram's and LINE's model, built on the DM tables rather than beside
-- them: pick some friends, name the thing, give it a picture, talk.
--
-- ONE CONVERSATION TABLE, NOT TWO
-- ---------------------------------------------------------------------
-- The obvious shape is `group_threads` + `group_messages` next to
-- `dm_threads` + `dm_messages`. It is rejected here, and the reason is worth
-- stating because it decided almost every other line in this file: a group
-- chat is not a different KIND of conversation, it is a conversation with a
-- different number of people in it. Everything a DM already does -- replies,
-- reactions, image and video attachments, shared pins, reports, unsends,
-- read cursors, the realtime signal, the R2 key shape, the Edge Function
-- that mints URLs for it -- a group does identically. A parallel table set
-- would fork every one of those, and each fork is a place the two drift.
--
-- So `dm_threads` grows a `kind`, and a group is a thread with more than two
-- members. The inbox is one list, `dm_messages` is one table, and the client
-- reuses one thread view.
--
-- MEMBERSHIP MOVES OUT OF THE THREAD ROW
-- ---------------------------------------------------------------------
-- `dm_threads.user_low`/`user_high` cannot express three people, so
-- membership becomes `dm_thread_members` -- for BOTH kinds, including the
-- direct threads that already exist. That is the part worth doing carefully:
-- leaving direct threads on the pair columns and groups on the new table
-- would mean every read path carries a CASE, and "who is in this
-- conversation" would have two answers that have to agree forever.
--
-- The pair columns stay, for exactly one job each:
--
--   * `user_low`/`user_high` keep the UNIQUE constraint that makes "one
--     direct thread per pair" a database guarantee rather than something
--     every caller remembers to check. They are null on groups, and
--     Postgres treats nulls as distinct in a unique index, so any number of
--     groups coexist under it without a partial index.
--   * `low_read_at`/`high_read_at` have no second job, and are dropped --
--     `dm_thread_members.last_read_at` is the one cursor now. (The comment
--     at the top of apps/web/src/web/useUnreadCounts.ts has described the
--     cursor as living at `dm_thread_members.last_read_at` since before this
--     migration existed. It is finally true.)
--
-- WHO CAN BE IN A GROUP, AND WHAT THAT COSTS
-- ---------------------------------------------------------------------
-- Migration 0026 bought a strong property: nobody who is not a mutual follow
-- can put text in front of you, which is why this app has no message-request
-- folder. A group necessarily weakens it, and pretending otherwise would be
-- worse than saying so.
--
-- What is kept: YOU CAN ONLY ADD PEOPLE YOU ARE MUTUAL FOLLOWS WITH.
-- `soso.dm_can_message` is re-checked per person on every add, against the
-- person doing the adding -- the same predicate, applied the same way, as
-- opening a DM. There is no path by which a stranger adds you to anything.
--
-- What is given up: once you are in a group, you see messages from members
-- you are not friends with, because that is what a group conversation is.
-- The mitigations are the ones that matter in practice rather than in
-- principle:
--
--   * A BLOCK STILL WINS. Messages from someone you have blocked, or who has
--     blocked you, are filtered out of your view of the group per message
--     (see the read policy and `list_dm_messages`) rather than the group
--     being torn down for everyone else. A direct thread still disappears
--     wholesale, unchanged.
--   * LEAVING IS ALWAYS AVAILABLE, to anyone, with no owner's permission,
--     and re-adding someone who left needs a member who is mutual follows
--     with them.
--   * THE CAP IS 32, matching Instagram's, so "a group" cannot become a
--     broadcast channel with an audience the sender never had.
--
-- A join-request flow would close the gap completely, and is deliberately
-- not built: it would make the ordinary case -- three friends starting a
-- chat -- a three-step negotiation, which is precisely the friction this
-- feature exists to remove. The trade is stated here so a later reader can
-- disagree with it knowingly.
--
-- SYSTEM MESSAGES
-- ---------------------------------------------------------------------
-- "Alex added Sam", "Alex named the group Tuesday Football". These live in
-- `dm_messages` as rows with an `event_kind` and an empty body, rather than
-- in a side table, for the same reason groups live in `dm_threads`: they are
-- ordered among the messages, they page with the messages, they arrive over
-- the same realtime signal, and they move `last_message_at` so a group you
-- were just added to surfaces in your inbox instead of sitting invisibly at
-- the bottom with no messages in it. A side table would need all of that
-- rebuilt and then merged back in on read.
--
-- They carry no text. The WORDS are the client's, composed from `event_kind`
-- plus the actor and target ids, because the alternative -- freezing an
-- English sentence into a row at write time -- cannot be translated, and
-- goes stale the moment somebody changes their display name.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- thread_kind
-- ----------------------------------------------------------------------------
-- An enum rather than a boolean `is_group`, on migration 0046's reasoning
-- for `media_kind`: the moment a third kind is plausible (a broadcast list,
-- a support thread) widening an enum is an ALTER TYPE and widening a boolean
-- is a rewrite of every reader.
create type public.thread_kind as enum ('direct', 'group');


-- ----------------------------------------------------------------------------
-- dm_threads learns what kind of thing it is
-- ----------------------------------------------------------------------------
-- `default 'direct'` is what makes this additive: every row written before
-- this migration is a two-person conversation and says so without being
-- touched.
alter table public.dm_threads
  add column kind       public.thread_kind not null default 'direct',
  -- Null is a real, ordinary state, not a missing value: a group nobody has
  -- named is rendered from its members' names instead ("Ana, Bo & Chi"),
  -- exactly as Instagram does. Storing that generated string would freeze it
  -- against the member list it was generated from.
  add column title      text,
  -- The group picture, an object path in the same public `avatars` bucket
  -- profile pictures use -- see the photo_path constraint below for why that
  -- needs no new bucket and no new storage policy.
  add column photo_path text,
  add column created_by uuid references public.profiles (id) on delete set null;

alter table public.dm_threads
  alter column user_low  drop not null,
  alter column user_high drop not null;

-- One constraint stating the whole shape of both kinds, rather than four
-- constraints each stating a corner of it. A direct thread is a pair and has
-- no name; a group has no pair and may have one.
alter table public.dm_threads
  add constraint dm_threads_kind_shape check (
    (kind = 'direct'
       and user_low is not null and user_high is not null
       and title is null and photo_path is null)
    or
    (kind = 'group'
       and user_low is null and user_high is null)
  ),
  add constraint dm_threads_title_shape check (
    title is null or length(btrim(title)) between 1 and 60
  ),
  -- The same shape `profiles.avatar_path` enforces (migration 0038): exactly
  -- two segments, no traversal. NOT tied to a particular account's id,
  -- though, and that difference is the whole reason group photos need no new
  -- infrastructure. A profile picture may only ever live in its own owner's
  -- folder; a group's is uploaded by whichever MEMBER chose it, into that
  -- member's own folder, through the unchanged `uploadAvatar` path and the
  -- unchanged `(storage.foldername(name))[1] = auth.uid()` insert policy. The
  -- bucket is public-read, so every member can display it regardless of who
  -- put it there.
  --
  -- What that costs, stated rather than buried: the object outlives the
  -- uploader's membership. Someone who sets a group photo and then leaves
  -- has left an object behind in their own folder that the group still
  -- points at. The alternative -- copying the bytes into a group-owned
  -- location on every change -- needs a second bucket, a second policy and a
  -- server-side copy, to fix a leak whose entire cost is one 40KB file.
  add constraint dm_threads_photo_shape check (
    photo_path is null or (
      length(photo_path) between 3 and 200
      and length(photo_path) - length(replace(photo_path, '/', '')) = 1
      and position('..' in photo_path) = 0
      and photo_path not like '/%'
    )
  );

comment on column public.dm_threads.title is
  'Group name, or null for an unnamed group (the client renders member names instead). Always null on a direct thread.';
comment on column public.dm_threads.photo_path is
  'Object path in the public avatars bucket, <uploader id>/<token>.jpg. Uploaded by a member into their own folder - see migration 0047.';


-- ----------------------------------------------------------------------------
-- dm_thread_members -- membership and the read cursor, for BOTH kinds
-- ----------------------------------------------------------------------------
create table public.dm_thread_members (
  thread_id    uuid not null references public.dm_threads (id) on delete cascade,
  user_id      uuid not null references public.profiles (id) on delete cascade,
  -- 'owner' is the person who created the group, and buys exactly one power:
  -- removing somebody else. Renaming, re-photographing and adding are open
  -- to every member, which is Instagram's split and the one that matches how
  -- these are actually used -- a group where only the founder may fix a typo
  -- in the name is a group with a permanent typo in its name.
  --
  -- Direct threads have two 'member' rows and no owner: there is nobody to
  -- remove and nothing to rename.
  role         text not null default 'member' check (role in ('owner', 'member')),
  joined_at    timestamptz not null default now(),
  -- Replaces dm_threads.low_read_at/high_read_at, dropped below. One column
  -- instead of two named after positions in a pair that no longer describes
  -- every thread.
  last_read_at timestamptz,
  primary key (thread_id, user_id)
);

-- The inbox's own access path: every thread I am in, which is the driving
-- query of `list_dm_threads`. The primary key covers the other direction.
create index dm_thread_members_user_idx on public.dm_thread_members (user_id);

alter table public.dm_thread_members enable row level security;


-- ----------------------------------------------------------------------------
-- soso.dm_is_member -- the predicate every path in this file rests on
-- ----------------------------------------------------------------------------
-- SECURITY DEFINER is not decoration here, it is what makes the read policy
-- on `dm_thread_members` possible at all. A policy on that table whose USING
-- clause selects from that same table recurses; a SECURITY DEFINER function
-- runs with the owner's rights and therefore bypasses RLS, so the policy
-- below terminates. This is the standard shape for membership-table policies
-- in Postgres, and the reason it is spelled out is that the version without
-- it fails at query time with a recursion error rather than at migration
-- time.
-- ----------------------------------------------------------------------------
create or replace function soso.dm_is_member(p_thread_id uuid, p_user_id uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select p_thread_id is not null
     and p_user_id is not null
     and exists (
       select 1 from public.dm_thread_members m
       where m.thread_id = p_thread_id and m.user_id = p_user_id
     );
$$;


-- ----------------------------------------------------------------------------
-- soso.dm_thread_visible -- membership, plus what a block does to it
-- ----------------------------------------------------------------------------
-- The two kinds answer "has a block ended this for me" differently, and this
-- is the one place that difference is expressed:
--
--   * A DIRECT thread vanishes entirely, in both directions, the instant
--     either side blocks. Unchanged from migration 0026.
--   * A GROUP does not. Blocking one of five people is not a request to
--     leave the conversation, and acting on it as though it were would hand
--     any member a way to remove themselves from everyone else's group by
--     accident. The block instead hides that person's MESSAGES, per message
--     -- see the read policy below.
-- ----------------------------------------------------------------------------
create or replace function soso.dm_thread_visible(p_thread_id uuid, p_user_id uuid)
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
      and soso.dm_is_member(t.id, p_user_id)
      and (t.kind <> 'direct' or not soso.is_blocked_pair(t.user_low, t.user_high))
  );
$$;


create policy dm_thread_members_read on public.dm_thread_members
  for select to authenticated
  using (soso.dm_is_member(thread_id, auth.uid()));

revoke all on public.dm_thread_members from anon, authenticated;
grant select on public.dm_thread_members to authenticated;


-- ----------------------------------------------------------------------------
-- Backfill, then retire the pair's read cursors
-- ----------------------------------------------------------------------------
-- Every existing direct thread gets its two member rows, carrying the read
-- cursors forward so nobody's unread count jumps on deploy. `joined_at` is
-- the thread's own creation time, which for a pair is exactly when both of
-- them joined it.
insert into public.dm_thread_members (thread_id, user_id, role, joined_at, last_read_at)
select id, user_low,  'member', created_at, low_read_at  from public.dm_threads where kind = 'direct'
union all
select id, user_high, 'member', created_at, high_read_at from public.dm_threads where kind = 'direct';

alter table public.dm_threads
  drop column low_read_at,
  drop column high_read_at;


-- ----------------------------------------------------------------------------
-- dm_messages learns about system events
-- ----------------------------------------------------------------------------
-- `sender_id` stays the ACTOR -- the person who did the thing -- so a system
-- row needs no new "who" column and renders as "You added Sam" or "Alex
-- added Sam" from the same comparison every other message already makes.
alter table public.dm_messages
  add column event_kind      text check (
    event_kind is null
    or event_kind in ('created', 'added', 'removed', 'left', 'renamed', 'photo')
  ),
  -- The person an 'added' or 'removed' event is about. Null on the events
  -- that are only about their actor.
  add column event_target_id uuid references public.profiles (id) on delete set null,
  -- The NEW NAME, on a 'renamed' event, and nothing else ever.
  --
  -- This is not the frozen-sentence problem the header rejects: a title is
  -- data, and it is the one piece of an event that cannot be recovered later.
  -- The thread's `title` column holds only the CURRENT name, so composing
  -- "Ana named the group X" from it would relabel every historical rename
  -- with the latest name the moment somebody renames it again -- a history
  -- that rewrites itself. The words around it are still the client's.
  add column event_text      text check (event_text is null or length(event_text) <= 60);

-- "Never entirely empty" has been widened twice already (0040 for images,
-- 0044 for shared pins) and is widened once more here rather than joined by
-- a second constraint that could disagree with it. A system row is the
-- inverse case: it must be empty, since its words are composed on the
-- client.
alter table public.dm_messages
  drop constraint dm_messages_not_empty,
  add constraint dm_messages_not_empty check (
    event_kind is not null
    or length(trim(body)) > 0
    or image_path is not null
    or shared_post_id is not null
  ),
  add constraint dm_messages_event_shape check (
    case
      when event_kind is null then event_target_id is null and event_text is null
      else length(body) = 0
       and image_path is null
       and shared_post_id is null
       and reply_to_id is null
    end
  );


-- ----------------------------------------------------------------------------
-- The read policies, restated against membership
-- ----------------------------------------------------------------------------
drop policy if exists dm_threads_read_own on public.dm_threads;
create policy dm_threads_read_member on public.dm_threads
  for select to authenticated
  using (soso.dm_thread_visible(id, auth.uid()));

drop policy if exists dm_messages_read_participants on public.dm_messages;
create policy dm_messages_read_members on public.dm_messages
  for select to authenticated
  using (
    soso.dm_thread_visible(dm_messages.thread_id, auth.uid())
    -- Per message, and this is the group half of the block rule. On a direct
    -- thread it is redundant (the whole thread is already gone); on a group
    -- it is the entire mechanism, and it lives in the POLICY rather than
    -- only in `list_dm_messages` so a realtime subscriber gets the same
    -- answer as a reader.
    and not soso.is_blocked_pair(auth.uid(), dm_messages.sender_id)
  );

drop policy if exists dm_message_reactions_read_participants on public.dm_message_reactions;
create policy dm_message_reactions_read_members on public.dm_message_reactions
  for select to authenticated
  using (
    exists (
      select 1 from public.dm_messages m
      where m.id = dm_message_reactions.message_id
        and soso.dm_thread_visible(m.thread_id, auth.uid())
    )
  );


-- ----------------------------------------------------------------------------
-- Realtime
-- ----------------------------------------------------------------------------
-- Membership changes are a signal the inbox needs: being added to a group is
-- something that happens TO you, with nothing of yours to trigger a refetch.
-- REPLICA IDENTITY FULL for migration 0012's reason -- the policy above
-- tests `thread_id`, which a DELETE event would otherwise not carry.
alter table public.dm_thread_members replica identity full;
alter publication supabase_realtime add table public.dm_thread_members;


-- ============================================================================
-- Shared builders
-- ============================================================================
-- Three functions the paths below all call, so that "what a member row looks
-- like", "what a thread row looks like" and "may this caller write here" each
-- have exactly one definition. The alternative is visible in the migrations
-- this one restates: `list_dm_threads` and `open_dm_thread` have carried
-- near-identical inline jsonb_build_object calls since 0026, and every
-- migration that added a field had to remember both.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- soso.dm_members_json -- who is in a thread, as the client wants them
-- ----------------------------------------------------------------------------
-- Excludes the viewer: every surface that renders this list already knows who
-- the viewer is and none of them draw the viewer into it. `p_limit` bounds
-- what the INBOX carries -- four is enough for an avatar stack and for "Ana,
-- Bo, Chi & 2 others", with `member_count` supplying the rest -- while
-- `list_dm_thread_members` passes null for the whole list.
-- ----------------------------------------------------------------------------
create or replace function soso.dm_members_json(
  p_thread_id uuid,
  p_viewer    uuid,
  p_limit     integer default null
)
  returns jsonb
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(row_json order by joined_at, user_id), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'id',      p.id,
      'handle',  p.handle,
      'name',    p.display_name,
      'avatar',  p.avatar_path,
      'role',    m.role,
      -- Carried so the client can mark someone you have blocked in the member
      -- list rather than silently showing a name whose messages it is also
      -- silently hiding. Two surfaces disagreeing about who is in the room is
      -- worse than either answer alone.
      'blocked', soso.is_blocked_pair(p_viewer, p.id)
    ) as row_json,
    m.joined_at,
    m.user_id
    from public.dm_thread_members m
    join public.profiles p on p.id = m.user_id
    where m.thread_id = p_thread_id
      and m.user_id <> p_viewer
    order by m.joined_at, m.user_id
    limit p_limit
  ) members;
$$;


-- ----------------------------------------------------------------------------
-- soso.dm_thread_json -- one inbox row, for either kind
-- ----------------------------------------------------------------------------
-- The direct-only keys (`other_id`, `other_handle`, `other_name`,
-- `other_avatar`) are kept rather than folded into `members`, and that is a
-- compatibility decision rather than an aesthetic one: every deployed client
-- reads them, and a browser holding the old bundle keeps working against a
-- database that has run this migration. They are null on a group, which such
-- a client renders as a nameless row -- visibly odd, but not broken, and only
-- until the web deploy lands.
--
-- `unread` counts from `greatest(last_read_at, joined_at)`, which matters
-- only for groups and matters a lot there: being added to a two-year-old
-- conversation must not arrive as 4,000 unread messages. Messages from
-- someone the viewer has blocked are excluded, so the badge agrees with the
-- list the viewer will actually be shown.
-- ----------------------------------------------------------------------------
create or replace function soso.dm_thread_json(p_thread_id uuid, p_viewer uuid)
  returns jsonb
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id',              t.id,
    'kind',            t.kind,
    'title',           t.title,
    'photo_path',      t.photo_path,
    'created_by',      t.created_by,
    'my_role',         me.role,
    'other_id',        o.id,
    'other_handle',    o.handle,
    'other_name',      o.display_name,
    'other_avatar',    o.avatar_path,
    'members',         soso.dm_members_json(t.id, p_viewer, 4),
    'member_count',    (select count(*) from public.dm_thread_members c where c.thread_id = t.id),
    'last_message_at', t.last_message_at,
    'last_body',       m.body,
    'last_has_image',  m.image_path is not null,
    'last_media_kind', m.media_kind,
    'last_has_post',   m.shared_post_id is not null,
    'last_sender_id',  m.sender_id,
    -- Groups prefix the preview with who said it ("Ana: on my way"), which a
    -- direct thread does not need and does not get -- the row is already
    -- titled with that person's name.
    'last_sender_name', case when t.kind = 'group' then ms.display_name end,
    -- So the inbox can render "Ana added Sam" as a preview line rather than a
    -- blank one. The client composes the words; these are the ingredients.
    'last_event_kind',        m.event_kind,
    'last_event_target_name', mt.display_name,
    'last_event_text',        m.event_text,
    'unread', (
      select count(*)
      from public.dm_messages n
      where n.thread_id = t.id
        and n.sender_id <> p_viewer
        and not soso.is_blocked_pair(p_viewer, n.sender_id)
        and n.created_at > greatest(
              coalesce(me.last_read_at, 'epoch'::timestamptz),
              me.joined_at
            )
    )
  )
  from public.dm_threads t
  join public.dm_thread_members me
    on me.thread_id = t.id and me.user_id = p_viewer
  left join public.profiles o
    on t.kind = 'direct'
   and o.id = case when p_viewer = t.user_low then t.user_high else t.user_low end
  left join lateral (
    select body, sender_id, image_path, shared_post_id, media_kind, event_kind, event_target_id, event_text
    from public.dm_messages
    where thread_id = t.id
      and not soso.is_blocked_pair(p_viewer, sender_id)
    order by created_at desc
    limit 1
  ) m on true
  left join public.profiles ms on ms.id = m.sender_id
  left join public.profiles mt on mt.id = m.event_target_id
  where t.id = p_thread_id;
$$;


-- ----------------------------------------------------------------------------
-- soso.dm_assert_can_post -- the one write predicate, for both kinds
-- ----------------------------------------------------------------------------
-- Called by `send_dm` and `toggle_dm_reaction`, which is the whole set of
-- things a non-member must not be able to do to a conversation. Raises rather
-- than returning a boolean, because every caller's response to false is the
-- same raise and two of them had already written it out.
--
-- The direct branch is migration 0026's rule, unchanged and still re-checked
-- on every write rather than trusted from when the thread was opened: an
-- unfollow or a block ends the conversation now.
--
-- The group branch cannot ask the same question -- there is no single "other
-- person" to be mutual follows with, and requiring it of all pairs would mean
-- a group dissolving the moment any two members stopped following each other.
-- Membership IS the authorization there, which is what makes who can be added
-- (`soso.dm_can_message`, against the adder, on every add) the load-bearing
-- check instead.
-- ----------------------------------------------------------------------------
create or replace function soso.dm_assert_can_post(p_thread_id uuid, p_user_id uuid)
  returns public.dm_threads
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_thread public.dm_threads;
  v_other  uuid;
begin
  select * into v_thread from public.dm_threads where id = p_thread_id;

  -- Same error for "no such thread" and "not yours", for the reason 0026
  -- gives: a probe for thread ids must not be able to tell them apart.
  if v_thread.id is null or not soso.dm_is_member(p_thread_id, p_user_id) then
    perform soso.fail('soso/thread_not_found');
  end if;

  if v_thread.kind = 'direct' then
    v_other := case when p_user_id = v_thread.user_low then v_thread.user_high else v_thread.user_low end;
    if not soso.dm_can_message(p_user_id, v_other) then
      perform soso.fail('soso/not_friends');
    end if;
  end if;

  return v_thread;
end;
$$;


-- ----------------------------------------------------------------------------
-- soso.dm_post_event -- a system message, written the one way
-- ----------------------------------------------------------------------------
-- Six callers below, each of which would otherwise repeat the insert and the
-- `last_message_at` bump. The bump is the part that is easy to forget and
-- expensive to omit: a group you were added to but that nobody has spoken in
-- has no other timestamp to sort your inbox by, so without it the group
-- appears at the very bottom of the list, below year-old conversations.
--
-- The actor's own read cursor moves to the event, on `send_dm`'s reasoning:
-- nothing you did yourself should come back to you as unread.
-- ----------------------------------------------------------------------------
create or replace function soso.dm_post_event(
  p_thread_id uuid,
  p_actor     uuid,
  p_kind      text,
  p_target    uuid default null,
  p_text      text default null
)
  returns void
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_at timestamptz;
begin
  insert into public.dm_messages (thread_id, sender_id, body, event_kind, event_target_id, event_text)
  values (p_thread_id, p_actor, '', p_kind, p_target, p_text)
  returning created_at into v_at;

  update public.dm_threads set last_message_at = v_at where id = p_thread_id;

  update public.dm_thread_members
    set last_read_at = v_at
    where thread_id = p_thread_id and user_id = p_actor;
end;
$$;


-- ----------------------------------------------------------------------------
-- soso.dm_reply_preview -- restated from 0046, plus the sender's name
-- ----------------------------------------------------------------------------
-- A quote in a group has to say WHO is being quoted. A direct thread could
-- get away with `sender_id` alone, because the client knows both names
-- already and comparing one id told it which to print; in a group there are
-- up to 32 and the reply preview is the only place that name appears.
--
-- Still no authorization check of its own, for the reason 0046 gives:
-- `send_dm` refuses a `reply_to` that is not in the same thread, so a quote
-- can never point out of the conversation it is rendered in.
-- ----------------------------------------------------------------------------
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
    'sender_name', p.display_name,
    'image_path', m.image_path,
    'image_width', m.image_width,
    'image_height', m.image_height,
    'media_kind', m.media_kind,
    'poster_path', m.poster_path,
    'has_post', m.shared_post_id is not null
  )
  from public.dm_messages m
  join public.profiles p on p.id = m.sender_id
  where p_id is not null and m.id = p_id;
$$;


-- ============================================================================
-- Creating and opening conversations
-- ============================================================================

-- ----------------------------------------------------------------------------
-- open_dm_thread -- restated from 0039, now writing member rows
-- ----------------------------------------------------------------------------
-- The insert into `dm_thread_members` is `on conflict do nothing` rather than
-- unconditional because this function is idempotent by construction: two
-- clients racing to open the same pair both reach the upsert, both get the
-- same thread id back, and the second must not fail on a member row the first
-- already wrote.
-- ----------------------------------------------------------------------------
create or replace function public.open_dm_thread(p_user_id uuid)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = public, extensions, pg_temp
as $$
declare
  v_uid    uuid := auth.uid();
  v_low    uuid;
  v_high   uuid;
  v_thread public.dm_threads;
begin
  if v_uid is null then
    perform soso.fail('soso/unauthenticated');
  end if;
  if not soso.dm_can_message(v_uid, p_user_id) then
    perform soso.fail('soso/not_friends');
  end if;

  v_low  := least(v_uid, p_user_id);
  v_high := greatest(v_uid, p_user_id);

  insert into public.dm_threads (user_low, user_high, kind)
  values (v_low, v_high, 'direct')
  on conflict (user_low, user_high) do update set user_low = excluded.user_low
  returning * into v_thread;

  insert into public.dm_thread_members (thread_id, user_id)
  values (v_thread.id, v_low), (v_thread.id, v_high)
  on conflict (thread_id, user_id) do nothing;

  return soso.dm_thread_json(v_thread.id, v_uid);
end;
$$;

grant execute on function public.open_dm_thread(uuid) to authenticated;


-- ----------------------------------------------------------------------------
-- soso.dm_photo_path_ok
-- ----------------------------------------------------------------------------
-- The `dm_threads_photo_shape` CHECK, available to the RPCs so a bad path
-- comes back as a `soso/` error code the client can render rather than as a
-- constraint violation it can only report as "something went wrong". The
-- constraint stays as the actual guarantee; this is the friendly half.
-- ----------------------------------------------------------------------------
create or replace function soso.dm_photo_path_ok(p_path text)
  returns boolean
  language sql
  immutable
as $$
  select p_path is null or (
    length(p_path) between 3 and 200
    and length(p_path) - length(replace(p_path, '/', '')) = 1
    and position('..' in p_path) = 0
    and p_path not like '/%'
  );
$$;


-- ----------------------------------------------------------------------------
-- create_group_thread
-- ----------------------------------------------------------------------------
-- AT LEAST TWO OTHER PEOPLE, and that is a product rule rather than a
-- technical floor. Selecting one friend and pressing go means "message this
-- person", and answering it with a one-on-one group would leave two separate
-- conversation surfaces for the same pair -- messages split across them, two
-- unread badges, and no way to tell from the inbox which is which. The client
-- opens the DM instead, exactly as Instagram does, and this refuses the case
-- so that a client which forgets to cannot create the mess.
--
-- NO UNIQUENESS CONSTRAINT ON THE MEMBER SET, deliberately. The same five
-- people may have a football group and a birthday-planning group, and a
-- database that refused the second would be wrong about what a group is.
-- That is also why this makes no attempt to return an existing thread the way
-- `open_dm_thread` does: every call creates a new conversation.
-- ----------------------------------------------------------------------------
create or replace function public.create_group_thread(
  p_title      text default null,
  p_member_ids uuid[] default '{}',
  p_photo_path text default null
)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = public, extensions, pg_temp
as $$
declare
  v_uid     uuid := auth.uid();
  v_title   text := nullif(btrim(coalesce(p_title, '')), '');
  v_photo   text := nullif(btrim(coalesce(p_photo_path, '')), '');
  v_ids     uuid[];
  v_member  uuid;
  v_thread  public.dm_threads;
  v_recent  integer;
begin
  if v_uid is null then
    perform soso.fail('soso/unauthenticated');
  end if;

  -- Deduplicated, and the creator removed if a client included them: the
  -- member array is a selection from a friends list, and "myself" is neither
  -- selectable there nor an error worth refusing the whole call over.
  select array_agg(distinct id) into v_ids
  from unnest(coalesce(p_member_ids, '{}'::uuid[])) as id
  where id is not null and id <> v_uid;

  v_ids := coalesce(v_ids, '{}'::uuid[]);

  if array_length(v_ids, 1) is null or array_length(v_ids, 1) < 2 then
    perform soso.fail('soso/group_too_small');
  end if;
  -- 31 others plus the creator. The cap is on the whole group, so it is
  -- checked against the same number `add_group_members` checks against.
  if array_length(v_ids, 1) + 1 > 32 then
    perform soso.fail('soso/group_too_large');
  end if;
  if v_title is not null and length(v_title) > 60 then
    perform soso.fail('soso/invalid_group_title');
  end if;
  if v_photo is not null and not soso.dm_photo_path_ok(v_photo) then
    perform soso.fail('soso/invalid_avatar_path');
  end if;

  -- Per person, against the CREATOR. This is the check that keeps migration
  -- 0026's guarantee alive: a stranger cannot be placed in a conversation
  -- with you, because the person doing the placing has to be your mutual
  -- follow first.
  foreach v_member in array v_ids loop
    if not soso.dm_can_message(v_uid, v_member) then
      perform soso.fail('soso/not_friends');
    end if;
  end loop;

  -- Groups are cheap to create and expensive to be added to, so creation is
  -- rate limited where opening a DM is not: 10 in an hour is far above any
  -- real use and far below anything that could be used to spray an account
  -- with conversations it has to leave one at a time.
  select count(*)::integer into v_recent
  from public.dm_threads
  where created_by = v_uid and created_at > now() - interval '1 hour';

  if v_recent >= 10 then
    perform soso.fail('soso/rate_limited');
  end if;

  insert into public.dm_threads (kind, title, photo_path, created_by, last_message_at)
  values ('group', v_title, v_photo, v_uid, now())
  returning * into v_thread;

  insert into public.dm_thread_members (thread_id, user_id, role)
  values (v_thread.id, v_uid, 'owner');

  insert into public.dm_thread_members (thread_id, user_id)
  select v_thread.id, id from unnest(v_ids) as id;

  perform soso.dm_post_event(v_thread.id, v_uid, 'created');

  return soso.dm_thread_json(v_thread.id, v_uid);
end;
$$;

grant execute on function public.create_group_thread(text, uuid[], text) to authenticated;


-- ============================================================================
-- Changing a group
-- ============================================================================

-- ----------------------------------------------------------------------------
-- soso.dm_assert_group_member -- the guard every mutator below opens with
-- ----------------------------------------------------------------------------
create or replace function soso.dm_assert_group_member(p_thread_id uuid, p_user_id uuid)
  returns public.dm_threads
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_thread public.dm_threads;
begin
  select * into v_thread from public.dm_threads where id = p_thread_id;

  if v_thread.id is null or not soso.dm_is_member(p_thread_id, p_user_id) then
    perform soso.fail('soso/thread_not_found');
  end if;
  -- A distinct code from `thread_not_found`, and safe to distinguish: the
  -- caller is already a member, so they know the thread exists and what kind
  -- it is. Nothing is disclosed that they cannot already see.
  if v_thread.kind <> 'group' then
    perform soso.fail('soso/not_group_thread');
  end if;

  return v_thread;
end;
$$;


-- ----------------------------------------------------------------------------
-- add_group_members -- any member may add their own friends
-- ----------------------------------------------------------------------------
-- The mutual-follow check is against the CALLER, not the group's creator, and
-- that is the point rather than a convenience: it means the property migration
-- 0026 bought survives at the only boundary where a group can widen. Every
-- person in a group was put there by somebody who was already their mutual
-- follow.
--
-- Idempotent on someone already in the group: they are skipped without an
-- error and without a second "added" event, so two members tapping Add on the
-- same person at once produces one join, not a duplicate-key failure.
-- ----------------------------------------------------------------------------
create or replace function public.add_group_members(p_thread_id uuid, p_user_ids uuid[])
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = public, extensions, pg_temp
as $$
declare
  v_uid    uuid := auth.uid();
  v_ids    uuid[];
  v_member uuid;
  v_count  integer;
begin
  if v_uid is null then
    perform soso.fail('soso/unauthenticated');
  end if;

  perform soso.dm_assert_group_member(p_thread_id, v_uid);

  select array_agg(distinct id) into v_ids
  from unnest(coalesce(p_user_ids, '{}'::uuid[])) as id
  where id is not null
    and id <> v_uid
    and not soso.dm_is_member(p_thread_id, id);

  v_ids := coalesce(v_ids, '{}'::uuid[]);

  -- Nobody left to add once the already-members are filtered out. Not an
  -- error: the caller wanted these people in the group, and they are.
  if array_length(v_ids, 1) is null then
    return soso.dm_thread_json(p_thread_id, v_uid);
  end if;

  select count(*)::integer into v_count
  from public.dm_thread_members where thread_id = p_thread_id;

  if v_count + array_length(v_ids, 1) > 32 then
    perform soso.fail('soso/group_too_large');
  end if;

  foreach v_member in array v_ids loop
    if not soso.dm_can_message(v_uid, v_member) then
      perform soso.fail('soso/not_friends');
    end if;
  end loop;

  foreach v_member in array v_ids loop
    insert into public.dm_thread_members (thread_id, user_id)
    values (p_thread_id, v_member);
    perform soso.dm_post_event(p_thread_id, v_uid, 'added', v_member);
  end loop;

  return soso.dm_thread_json(p_thread_id, v_uid);
end;
$$;

grant execute on function public.add_group_members(uuid, uuid[]) to authenticated;


-- ----------------------------------------------------------------------------
-- remove_group_member -- the owner's one extra power
-- ----------------------------------------------------------------------------
-- Removing yourself is `leave_group_thread`, not this. Two functions rather
-- than one that branches, because they are different acts with different
-- authorization (anyone may leave; only the owner may remove) and because the
-- system message they post is a different one -- "Ana left" and "Ana removed
-- Bo" are not the same sentence and should not be the same row.
-- ----------------------------------------------------------------------------
create or replace function public.remove_group_member(p_thread_id uuid, p_user_id uuid)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = public, extensions, pg_temp
as $$
declare
  v_uid  uuid := auth.uid();
  v_role text;
begin
  if v_uid is null then
    perform soso.fail('soso/unauthenticated');
  end if;

  perform soso.dm_assert_group_member(p_thread_id, v_uid);

  select role into v_role
  from public.dm_thread_members
  where thread_id = p_thread_id and user_id = v_uid;

  if v_role <> 'owner' then
    perform soso.fail('soso/owner_only');
  end if;
  if p_user_id = v_uid then
    -- The owner leaving is a real thing they may do; it just is not this
    -- call, and silently rewriting it into one would hide the promotion of a
    -- new owner that leaving performs.
    perform soso.fail('soso/bad_request');
  end if;
  if not soso.dm_is_member(p_thread_id, p_user_id) then
    -- Already gone. The caller wanted them not in the group, and they are
    -- not -- the same "no-op, not an error" shape delete_dm_message uses.
    return soso.dm_thread_json(p_thread_id, v_uid);
  end if;

  delete from public.dm_thread_members
  where thread_id = p_thread_id and user_id = p_user_id;

  perform soso.dm_post_event(p_thread_id, v_uid, 'removed', p_user_id);

  return soso.dm_thread_json(p_thread_id, v_uid);
end;
$$;

grant execute on function public.remove_group_member(uuid, uuid) to authenticated;


-- ----------------------------------------------------------------------------
-- leave_group_thread -- available to anyone, always
-- ----------------------------------------------------------------------------
-- THE EVENT IS POSTED BEFORE THE MEMBERSHIP ROW GOES, because
-- `soso.dm_post_event` moves the leaver's own read cursor and there has to be
-- a row left to move.
--
-- Two pieces of housekeeping the obvious version forgets:
--
--   * THE OWNER LEAVING PROMOTES SOMEBODY. Without it, a group whose creator
--     leaves has no owner and therefore nobody who can ever remove anyone --
--     a permanently un-moderatable room. The longest-standing remaining
--     member takes it, which is the least arbitrary rule available that needs
--     no input.
--   * THE LAST MEMBER LEAVING DELETES THE THREAD. An empty conversation is
--     unreachable by construction (every read path is membership-scoped), so
--     leaving it in place means rows nobody can ever see again. The cascade
--     takes its messages, reactions and R2 keys' references with it.
-- ----------------------------------------------------------------------------
create or replace function public.leave_group_thread(p_thread_id uuid)
  returns void
  language plpgsql
  volatile
  security definer
  set search_path = public, extensions, pg_temp
as $$
declare
  v_uid       uuid := auth.uid();
  v_role      text;
  v_remaining integer;
begin
  if v_uid is null then
    perform soso.fail('soso/unauthenticated');
  end if;

  perform soso.dm_assert_group_member(p_thread_id, v_uid);

  select role into v_role
  from public.dm_thread_members
  where thread_id = p_thread_id and user_id = v_uid;

  perform soso.dm_post_event(p_thread_id, v_uid, 'left');

  delete from public.dm_thread_members
  where thread_id = p_thread_id and user_id = v_uid;

  select count(*)::integer into v_remaining
  from public.dm_thread_members where thread_id = p_thread_id;

  if v_remaining = 0 then
    delete from public.dm_threads where id = p_thread_id;
    return;
  end if;

  if v_role = 'owner' then
    update public.dm_thread_members
      set role = 'owner'
      where thread_id = p_thread_id
        and user_id = (
          select user_id from public.dm_thread_members
          where thread_id = p_thread_id
          order by joined_at, user_id
          limit 1
        );
  end if;
end;
$$;

grant execute on function public.leave_group_thread(uuid) to authenticated;


-- ----------------------------------------------------------------------------
-- rename_group_thread / set_group_thread_photo -- any member
-- ----------------------------------------------------------------------------
-- Both no-op when the value did not actually change, which is not an
-- optimization: without it, opening the rename sheet and pressing Save
-- without typing posts "Ana named the group Football" into a group already
-- called Football. The same applies to re-picking the photo that is already
-- set, which a cropper makes easy to do by accident.
-- ----------------------------------------------------------------------------
create or replace function public.rename_group_thread(p_thread_id uuid, p_title text)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = public, extensions, pg_temp
as $$
declare
  v_uid    uuid := auth.uid();
  v_thread public.dm_threads;
  v_title  text := nullif(btrim(coalesce(p_title, '')), '');
begin
  if v_uid is null then
    perform soso.fail('soso/unauthenticated');
  end if;

  v_thread := soso.dm_assert_group_member(p_thread_id, v_uid);

  if v_title is not null and length(v_title) > 60 then
    perform soso.fail('soso/invalid_group_title');
  end if;

  if v_title is not distinct from v_thread.title then
    return soso.dm_thread_json(p_thread_id, v_uid);
  end if;

  update public.dm_threads set title = v_title where id = p_thread_id;

  perform soso.dm_post_event(p_thread_id, v_uid, 'renamed', null, v_title);

  return soso.dm_thread_json(p_thread_id, v_uid);
end;
$$;

grant execute on function public.rename_group_thread(uuid, text) to authenticated;


create or replace function public.set_group_thread_photo(p_thread_id uuid, p_photo_path text)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = public, extensions, pg_temp
as $$
declare
  v_uid    uuid := auth.uid();
  v_thread public.dm_threads;
  v_photo  text := nullif(btrim(coalesce(p_photo_path, '')), '');
begin
  if v_uid is null then
    perform soso.fail('soso/unauthenticated');
  end if;

  v_thread := soso.dm_assert_group_member(p_thread_id, v_uid);

  if not soso.dm_photo_path_ok(v_photo) then
    perform soso.fail('soso/invalid_avatar_path');
  end if;

  if v_photo is not distinct from v_thread.photo_path then
    return soso.dm_thread_json(p_thread_id, v_uid);
  end if;

  update public.dm_threads set photo_path = v_photo where id = p_thread_id;

  perform soso.dm_post_event(p_thread_id, v_uid, 'photo');

  return soso.dm_thread_json(p_thread_id, v_uid);
end;
$$;

grant execute on function public.set_group_thread_photo(uuid, text) to authenticated;


-- ----------------------------------------------------------------------------
-- list_dm_thread_members -- the whole list, for the group's detail screen
-- ----------------------------------------------------------------------------
create or replace function public.list_dm_thread_members(p_thread_id uuid)
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

  return soso.dm_members_json(p_thread_id, v_uid, null);
end;
$$;

grant execute on function public.list_dm_thread_members(uuid) to authenticated;


-- ============================================================================
-- The message paths, restated against membership
-- ============================================================================
-- Every one of these previously reached for `user_low`/`user_high` to answer
-- "is the caller in this conversation", which is now `soso.dm_is_member`.
-- They are restated in full rather than patched, following this repository's
-- existing practice: a `create or replace` that shows the whole function is
-- readable in one place, where a diff against three migrations ago is not.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- send_dm -- restated from 0046, group-aware
-- ----------------------------------------------------------------------------
-- Two changes, both in the bookkeeping rather than in what a message is:
--
--   * `soso.dm_assert_can_post` replaces the inline pair lookup and the
--     mutual-follow check, so the difference between what a direct thread
--     requires and what a group requires lives in one function instead of
--     being re-decided here.
--   * The sender's read cursor moves in `dm_thread_members` rather than in
--     one of two columns chosen by which half of the pair they are.
--
-- The image key is still bound to the thread (`soso.owns_message_image`), and
-- that check needs nothing new for groups: the key shape is
-- `dm/<thread>/<sender>/<uuid>.<ext>` either way, and "minted for this thread"
-- means the same thing whether the thread holds two people or twenty.
-- ----------------------------------------------------------------------------
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
  v_recent integer;
  v_row    public.dm_messages;
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

grant execute on function public.send_dm(uuid, text, uuid, text, integer, integer, uuid, text, text, integer) to authenticated;


-- ----------------------------------------------------------------------------
-- list_dm_messages -- restated from 0046, with senders and system events
-- ----------------------------------------------------------------------------
-- THE SENDER'S IDENTITY NOW TRAVELS WITH EACH MESSAGE. A direct thread did
-- not need it: two people, and the client already held both names, so
-- comparing `sender_id` against its own id decided everything. A group has up
-- to 32, so the name and avatar beside a bubble have to come from the row
-- rather than from the thread -- which is exactly what
-- `list_recent_chat_messages` has always done for the room, and this now
-- matches it key for key.
--
-- HISTORY IS NOT GATED ON `joined_at`, and that is a decision rather than an
-- oversight. Somebody added to a group can read what was said in it before
-- they arrived, which is Instagram's behaviour and not WhatsApp's or
-- Signal's. The argument for gating is real -- those messages were sent to a
-- smaller audience than the one that can now read them -- and it was weighed
-- against two things that decided it:
--
--   * A REPLY QUOTE WOULD LEAK ANYWAY. `soso.dm_reply_preview` renders the
--     quoted message inside the quoting one, so a message from before you
--     joined reaches you the moment anyone replies to it. Closing that needs
--     the preview to become per-viewer, at which point a conversation
--     renders differently for each member and a quote can be a blank.
--   * SCROLLING INTO A WALL IS WORSE THAN THE ALTERNATIVE. A group that
--     visibly begins mid-conversation, where an ordinary reply points at
--     nothing, reads as broken rather than as private.
--
-- What protects the conversation instead is who can be added at all: only by
-- a member, only somebody that member is already mutual follows with.
--
-- Messages from a blocked sender are filtered here as well as in the read
-- policy. Both, not either: the policy is what a realtime subscriber and a
-- direct table read get, and this is what makes the filtered list the one the
-- pagination cursor is computed from.
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


-- ----------------------------------------------------------------------------
-- list_dm_threads -- one inbox, both kinds
-- ----------------------------------------------------------------------------
-- Driven off `dm_thread_members` rather than off the pair columns, which is
-- what makes a group appear in the list at all. The per-row shape is
-- `soso.dm_thread_json`, so the inbox and `open_dm_thread` and every group
-- mutator return literally the same object.
--
-- A group with no messages still sorts sensibly: `create_group_thread` sets
-- `last_message_at` at creation and its 'created' event confirms it, so a
-- new group lands at the top of the inbox rather than at the bottom under
-- `nulls last`.
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
    select soso.dm_thread_json(t.id, auth.uid()) as row_json,
           t.last_message_at as sort_at
    from public.dm_threads t
    join public.dm_thread_members me
      on me.thread_id = t.id and me.user_id = auth.uid()
    where t.kind <> 'direct'
       or not soso.is_blocked_pair(t.user_low, t.user_high)
  ) threads;
$$;


-- ----------------------------------------------------------------------------
-- mark_dm_read
-- ----------------------------------------------------------------------------
-- `greatest` so a second device sitting further behind cannot un-read
-- messages, on `mark_chat_room_read`'s reasoning from 0045. The pair version
-- this replaces could skip that only because it wrote `now()` into whichever
-- of two columns matched the caller.
-- ----------------------------------------------------------------------------
create or replace function public.mark_dm_read(p_thread_id uuid)
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

  update public.dm_thread_members
    set last_read_at = greatest(coalesce(last_read_at, 'epoch'::timestamptz), now())
    where thread_id = p_thread_id and user_id = v_uid;
end;
$$;


-- ----------------------------------------------------------------------------
-- dm_thread_read_state -- how far everyone else has read
-- ----------------------------------------------------------------------------
-- REPLACES `dm_other_read_at`, which returned a single timestamp because a
-- thread had exactly one other person in it. The same call now answers for
-- any number, and a direct thread is the one-element case rather than a
-- special one -- so the client's receipt logic ("the newest message of mine
-- this person has reached") is one function that runs over a list of length
-- 1 or length 17.
--
-- Names and avatars come along because a group renders receipts as faces
-- under the message, the way Instagram does, rather than as the word "Seen".
--
-- Returns an empty array rather than failing for a thread the caller is not
-- in: the absence of a receipt is not information worth an error, and every
-- other read path already refuses that thread's contents.
-- ----------------------------------------------------------------------------
create or replace function public.dm_thread_read_state(p_thread_id uuid)
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
                 'user_id', m.user_id,
                 'name',    p.display_name,
                 'handle',  p.handle,
                 'avatar',  p.avatar_path,
                 'read_at', m.last_read_at
               )
               order by m.last_read_at desc nulls last
             )
      from public.dm_thread_members m
      join public.profiles p on p.id = m.user_id
      where m.thread_id = p_thread_id
        and m.user_id <> auth.uid()
        and m.last_read_at is not null
        and not soso.is_blocked_pair(auth.uid(), m.user_id)
        and soso.dm_thread_visible(p_thread_id, auth.uid())
    ),
    '[]'::jsonb
  );
$$;

grant execute on function public.dm_thread_read_state(uuid) to authenticated;

-- Nothing calls it any more, and leaving it would leave a second, pair-shaped
-- answer to a question that now has a membership-shaped one. It also no longer
-- compiles: the columns it reads are gone.
drop function if exists public.dm_other_read_at(uuid);


-- ----------------------------------------------------------------------------
-- may_read_dm_thread -- what the Edge Function asks before minting a URL
-- ----------------------------------------------------------------------------
-- The `message-image-urls` function is unchanged by this migration, and that
-- is the payoff for keeping one thread table: a group's attachments live
-- under the same `dm/<thread>/<sender>/<uuid>` keys, and the only thing that
-- had to learn about groups is the membership test inside this predicate.
-- ----------------------------------------------------------------------------
create or replace function public.may_read_dm_thread(p_thread_id uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select soso.dm_thread_visible(p_thread_id, auth.uid());
$$;


-- ----------------------------------------------------------------------------
-- toggle_dm_reaction -- restated from 0039 against membership
-- ----------------------------------------------------------------------------
create or replace function public.toggle_dm_reaction(p_message_id uuid, p_emoji text)
  returns void
  language plpgsql
  volatile
  security definer
  set search_path = public, extensions, pg_temp
as $$
declare
  v_uid       uuid := auth.uid();
  v_emoji     text := trim(coalesce(p_emoji, ''));
  v_thread_id uuid;
  v_sender    uuid;
  v_event     text;
  v_existing  text;
begin
  if v_uid is null then
    perform soso.fail('soso/unauthenticated');
  end if;
  if length(v_emoji) = 0 or length(v_emoji) > 16 then
    perform soso.fail('soso/invalid_reaction');
  end if;

  select thread_id, sender_id, event_kind into v_thread_id, v_sender, v_event
  from public.dm_messages where id = p_message_id;

  if v_thread_id is null then
    perform soso.fail('soso/message_not_found');
  end if;
  -- Reacting to "Ana added Sam" is not a thing the UI offers, and a client
  -- that asked for it anyway would be writing a reaction nothing renders.
  if v_event is not null then
    perform soso.fail('soso/message_not_found');
  end if;
  -- A message you cannot see is a message you cannot react to. In a group
  -- that is what a block means; the same code as a message that is not there
  -- because, to this caller, it is not.
  if soso.is_blocked_pair(v_uid, v_sender) then
    perform soso.fail('soso/message_not_found');
  end if;

  -- Same predicate as sending. A reaction is a write into somebody else's
  -- conversation, so it answers to the same question a message does.
  perform soso.dm_assert_can_post(v_thread_id, v_uid);

  select emoji into v_existing
  from public.dm_message_reactions
  where message_id = p_message_id and user_id = v_uid;

  if v_existing is null then
    insert into public.dm_message_reactions (message_id, user_id, emoji)
    values (p_message_id, v_uid, v_emoji);
  elsif v_existing = v_emoji then
    delete from public.dm_message_reactions
    where message_id = p_message_id and user_id = v_uid;
  else
    update public.dm_message_reactions
    set emoji = v_emoji, created_at = now()
    where message_id = p_message_id and user_id = v_uid;
  end if;
end;
$$;


-- ----------------------------------------------------------------------------
-- delete_dm_message -- restated from 0026, refusing system rows
-- ----------------------------------------------------------------------------
-- Sender-only, unchanged, which for a system event would mean the actor could
-- unsend "Ana removed Bo" and leave the removal unexplained. Refused instead:
-- a group's history of who joined and who left is the one part of it that is
-- not anybody's message to take back.
-- ----------------------------------------------------------------------------
create or replace function public.delete_dm_message(p_message_id uuid)
  returns void
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_thread_id uuid;
begin
  if auth.uid() is null then
    perform soso.fail('soso/unauthenticated');
  end if;

  select thread_id into v_thread_id
  from public.dm_messages
  where id = p_message_id and sender_id = auth.uid() and event_kind is null;

  if v_thread_id is null then
    -- Already gone, never yours, or not a message. Not an error: the caller
    -- wanted it to not exist, and it does not.
    return;
  end if;

  delete from public.dm_messages
  where id = p_message_id and sender_id = auth.uid();

  -- The inbox sorts on last_message_at, so unsending the newest message has
  -- to move it back to whatever is now newest.
  update public.dm_threads t
    set last_message_at = (
      select max(created_at) from public.dm_messages where thread_id = t.id
    )
    where t.id = v_thread_id;
end;
$$;


-- ----------------------------------------------------------------------------
-- report_dm_message -- restated from 0026 against membership
-- ----------------------------------------------------------------------------
create or replace function public.report_dm_message(
  p_message_id uuid,
  p_reason     text,
  p_disclosed  text default null
)
  returns void
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_uid       uuid := auth.uid();
  v_thread_id uuid;
begin
  if v_uid is null then
    perform soso.fail('soso/unauthenticated');
  end if;

  -- Only a participant, and only a message that exists. Without this, the
  -- report table would accept arbitrary message ids paired with arbitrary
  -- "disclosed" text -- a way to put words in someone else's mouth in a
  -- moderation queue.
  select thread_id into v_thread_id
  from public.dm_messages where id = p_message_id and event_kind is null;

  if v_thread_id is null or not soso.dm_is_member(v_thread_id, v_uid) then
    perform soso.fail('soso/message_not_found');
  end if;

  insert into public.dm_message_reports (message_id, reported_by, reason, disclosed_plaintext)
  values (
    p_message_id,
    v_uid,
    coalesce(nullif(trim(p_reason), ''), 'other'),
    nullif(trim(coalesce(p_disclosed, '')), '')
  )
  on conflict (message_id, reported_by) do nothing;
end;
$$;
