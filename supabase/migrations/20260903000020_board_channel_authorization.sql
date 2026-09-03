-- ============================================================================
-- 0020  Board live-channel authorization
-- ============================================================================
--
-- Closes the gap flagged on `SosoGateway.subscribeBoardStrokes` (see that
-- doc comment, being rewritten in the same change as this migration) and in
-- the plan's own "access control on tiles/channel" step: until now,
-- `board:{boardId}` was a Supabase Realtime Broadcast channel created with no
-- `private` option, which makes it a legacy, unauthenticated, always-open
-- channel — anyone who knew or guessed a board's id could listen to its live
-- strokes regardless of that post's audience, and could publish strokes onto
-- it, whether or not one of the real participants' own clients might later
-- flush that vandalism into R2. Tile access control (the signed URLs
-- `board-tile-urls` mints) was unaffected by this and did not need fixing.
--
-- ONE DELIBERATE CORRECTION TO THE PLAN'S OWN WORDING
-- ------------------------------------------------------------------------
-- DRAWING_BOARDS_PLAN.md describes this as "a policy on realtime.channels
-- deciding who may join". That table is not the actual mechanism Supabase
-- currently ships for this — the real mechanism ("Realtime Authorization")
-- is RLS on `realtime.messages`, gated per-message by the channel's topic
-- string via the `realtime.topic()` helper, combined with creating the
-- channel client-side with `{ config: { private: true } }` (see the
-- `supabase-gateway.ts` change alongside this migration). Functionally this
-- is exactly what the plan asked for — a private board's live strokes are
-- inaccessible to anyone `can_see_post` would already say no to — just
-- implemented against the table Supabase actually authorizes private
-- channels through, not the one the plan named.
--
-- WHY A SEPARATE HELPER FUNCTION RATHER THAN INLINING can_see_post
-- ------------------------------------------------------------------------
-- A `realtime.messages` RLS policy only has the topic string to work with —
-- there is no `board_id` column to join on the way `board_tiles.board_id`
-- lets `board_tiles_read` join directly. `soso.can_access_board_topic`
-- exists purely to turn `'board:<uuid>'` into that lookup, safely: a
-- malformed or non-board topic (this project's Realtime connection is not
-- used for anything else yet, but nothing stops a client from trying) must
-- deny rather than error a cast, since an exception inside an RLS policy
-- would surface as a hard failure to the connecting client rather than a
-- quiet "no access".
-- ============================================================================

create or replace function soso.can_access_board_topic(p_topic text)
  returns boolean
  language plpgsql
  stable
  security definer
  set search_path = public, extensions, pg_temp
as $$
declare
  v_board_id uuid;
begin
  -- Anchored, exact-length match before ever attempting the uuid cast below
  -- — ::uuid raises on a malformed string, and raising here would fail the
  -- whole policy check with an error rather than the "just say no" this
  -- needs. Canonical uuid text form only (36 chars, hyphenated); anything
  -- else is rejected here rather than left to the cast to discover.
  if p_topic is null or p_topic !~ '^board:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    return false;
  end if;

  v_board_id := substring(p_topic from 7)::uuid;

  -- The same predicate that gates reading the board's pin at all (RLS on
  -- public.boards/board_tiles, migration 0018) and gates flushing a tile
  -- (flush_board_tile). One join to posts, one call to can_see_post — no
  -- new visibility rule, just this rule's third enforcement point.
  return exists (
    select 1
    from public.posts p
    where p.id = v_board_id
      and soso.can_see_post(auth.uid(), p.author_id, p.audience, p.id)
  );
end;
$$;

comment on function soso.can_access_board_topic(text) is
  'Parses a board''s realtime.messages topic (''board:<uuid>'') and applies '
  'soso.can_see_post to it. Used only by the RLS policies below; never '
  'raises on a malformed topic, it just returns false.';

revoke execute on function soso.can_access_board_topic(text) from public, anon;
grant execute on function soso.can_access_board_topic(text) to authenticated;


-- ----------------------------------------------------------------------------
-- realtime.messages — the actual Broadcast Authorization gate
-- ----------------------------------------------------------------------------
-- No `alter table ... enable row level security` here, and deliberately so
-- — a first version of this migration had one, defended in this same
-- comment as "idempotent, a harmless no-op." That reasoning was wrong in a
-- way only a real deploy surfaced: `must be owner of table messages`
-- (SQLSTATE 42501). Postgres checks ownership before it ever asks whether
-- an ALTER would be a no-op, and on a hosted Supabase project
-- `realtime.messages` is owned by an internal role, not the `postgres` role
-- `supabase db push` runs as — no migration here can ever hold that
-- ownership, this was never a permission this migration was merely missing
-- by oversight. It also wasn't needed: Supabase ships this table with RLS
-- already enabled by default specifically so `CREATE POLICY` on it is the
-- one operation a project's migrations are expected to run — which
-- apparently does not require ownership the way ALTER does, or this
-- statement would have failed the exact same way.
--
-- Both policies restrict to `authenticated`: this app's every user is
-- anonymously signed in (bootstrap.ts's ensureSession, unrelated to this
-- migration) rather than a fully anonymous connection with no session at
-- all, and Realtime private channels require an authenticated connection to
-- evaluate RLS against in the first place — there is no `anon`-role case to
-- also grant here, unlike posts/board_tiles' own read policies.
-- ----------------------------------------------------------------------------

create policy board_broadcast_receive on realtime.messages
  for select
  to authenticated
  using (
    realtime.topic() like 'board:%'
    and soso.can_access_board_topic(realtime.topic())
  );

create policy board_broadcast_send on realtime.messages
  for insert
  to authenticated
  with check (
    realtime.topic() like 'board:%'
    and soso.can_access_board_topic(realtime.topic())
  );
