-- ============================================================================
-- 0050  Reserve the "@all" handle
-- ============================================================================
--
-- "@all" in a group is about to mean something specific — mention every
-- current member at once (see mentions.ts's `MENTION_ALL_HANDLE`, and the
-- client-side expansion in DmThreadView.tsx) — and that only works
-- unambiguously if no real profile can ever hold the handle "all". Mirrors
-- `packages/core/src/domain/phone.ts`'s own `RESERVED_HANDLES`, the same
-- split migration 0031's own version of this table describes: the browser
-- copy is for instant feedback while typing, this one is what actually
-- decides.
--
-- Existing accounts are not touched. This is a pre-launch project with no
-- real users yet (see the other reserved-handle entries, added the same
-- way); if that ever changes, reserving a word already in use would need a
-- migration path for whoever holds it, not just an insert.
-- ============================================================================

insert into public.reserved_handles (handle) values ('all')
on conflict (handle) do nothing;
