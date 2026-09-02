-- ============================================================================
-- 0021  Enable `board` — for testing, not yet a full launch
-- ============================================================================
--
-- Per the plan's own stated build order (schema, gateway, canvas UI,
-- broadcast layer, ACCESS CONTROL, moderation, then the flip — deliberately
-- last), everything up to and including access control on the tile index
-- and the live channel now exists: schema (0018), gateway + demo fallback,
-- single-player canvas, the broadcast layer, and channel authorization
-- (0020, alongside this migration). This flips `is_enabled` so that work is
-- actually reachable, for the specific purpose of testing it.
--
-- WHAT THIS DELIBERATELY SKIPS, ON EXPLICIT INSTRUCTION
-- ------------------------------------------------------------------------
-- Moderation does not exist yet: `boards.locked` is a real column that
-- `flush_board_tile` really enforces, but nothing can set it in response to
-- a report — `moderation_reports` does not accept a board as a target. If
-- someone draws something genuinely harmful on a public board, there is
-- currently no tooling to act on it short of a manual database operation.
-- That gap is real and unchanged by this migration; it is simply not what
-- this migration was asked to close. Treat this flip as "reachable for
-- testing", not "ready for real users" — the plan's own build order still
-- calls for moderation before that would be true.
-- ============================================================================

update public.post_categories
set is_enabled = true
where key = 'board';
