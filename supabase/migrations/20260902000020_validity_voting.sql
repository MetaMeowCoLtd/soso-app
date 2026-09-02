-- ============================================================================
-- 0020  Validity voting replaces the resolution-flag notify flow
-- ============================================================================
--
-- Until now there were two, mostly separate, "is this still accurate" signals:
--
--   1. post_votes (+1/-1, 0003) — already computed into confirm_count /
--      dispute_count by soso.tg_votes_recount, and already exposed on every
--      lightweight pin as `n` = confirm_count - dispute_count (soso.pin,
--      0011). Never consumed by anything visual before this migration.
--   2. resolution_flags + flag_post_resolved (0014) — a non-author flagging a
--      post as "resolved" or "out of date", which did nothing to the post
--      itself: it just notified the author, who alone decided whether to
--      remove it (via resolve_post, unaffected by this migration).
--
-- This migration retires (2) and gives (1) real teeth:
--
--   - The existing dispute-driven auto-hide in tg_votes_recount is replaced
--     with early expiry: once net (confirm - dispute) drops to or below
--     soso.dispute_threshold()'s (renegotiated) meaning, the post is expired
--     the exact same way resolve_post already expires one — expires_at =
--     now() — rather than flipped to a new 'hidden' status. Every read path
--     already excludes an expired post, so this needs no new case anywhere.
--   - resolution_flags and flag_post_resolved are dropped outright. The
--     corresponding "notify the author" webhook path in the Edge Function is
--     removed in the same change (see notify-new-pin/index.ts).
--
-- What this deliberately does NOT touch: post_votes, vote_post, soso.pin
-- (the `n` field it already emits is exactly what the client now renders
-- pin color/opacity from), and resolve_post (the author's own immediate
-- removal — a distinct, still-wanted action).
-- ============================================================================


-- ----------------------------------------------------------------------------
-- soso.dispute_threshold — repurposed as the delete threshold's magnitude
-- ----------------------------------------------------------------------------
-- Previously "how many net disputes trigger auto-hide"; now "how far net can
-- drop before the post is expired outright". Kept as the same named function,
-- same schema, rather than dropped and replaced, since demo-gateway.ts (the
-- offline fallback) already mirrors this exact value by name in a comment —
-- changing what it MEANS without changing what it's CALLED keeps that
-- cross-reference honest instead of silently stale.
-- ----------------------------------------------------------------------------
comment on function soso.dispute_threshold() is
  'Magnitude of the net (confirm_count - dispute_count) score at or below '
  'which a post is expired outright by tg_votes_recount. Was previously the '
  'threshold for an auto-hide status change; repurposed in migration 0020 to '
  'directly gate early expiry instead, alongside dropping resolution_flags.';


-- ----------------------------------------------------------------------------
-- tg_votes_recount — hide-on-dispute becomes expire-on-net-threshold
-- ----------------------------------------------------------------------------
create or replace function soso.tg_votes_recount()
  returns trigger
  language plpgsql
  set search_path = public, pg_temp
as $$
declare
  v_post_id uuid := coalesce(new.post_id, old.post_id);
  v_up      integer;
  v_down    integer;
begin
  select
    count(*) filter (where vote = 1)::integer,
    count(*) filter (where vote = -1)::integer
  into v_up, v_down
  from public.post_votes where post_id = v_post_id;

  update public.posts
  set confirm_count = v_up,
      dispute_count = v_down,
      -- Reuses the exact mechanism resolve_post uses for the author's own
      -- early removal: moving expires_at into the past. That means a
      -- vote-driven removal disappears through the SAME read-path exclusion
      -- (feed_delta / cell_counts / post_detail already filter on
      -- expires_at) as a naturally-expired or author-resolved post, with no
      -- new state for any client to special-case. Only ever moves
      -- expires_at earlier, never later, and only while still live — a post
      -- already expired or removed has nothing left for a vote to do.
      expires_at = case
        when status = 'live'
             and expires_at > now()
             and (v_up - v_down) <= -soso.dispute_threshold()
        then now()
        else expires_at
      end
  where id = v_post_id;

  return null;
end;
$$;

comment on function soso.tg_votes_recount() is
  'Recomputes confirm_count/dispute_count on every post_votes change and '
  'expires the post outright once net (confirm - dispute) drops to or below '
  '-soso.dispute_threshold(). Replaces the earlier status=''hidden'' '
  'auto-hide behaviour as of migration 0020 — see that migration for why.';


-- ----------------------------------------------------------------------------
-- Drop the resolution-flag notify flow
-- ----------------------------------------------------------------------------
-- Order matters: the function first (it references the table), then the
-- table (which drops its policies, index, and grants with it).
-- ----------------------------------------------------------------------------
drop function if exists public.flag_post_resolved(uuid, text);
drop table if exists public.resolution_flags;
