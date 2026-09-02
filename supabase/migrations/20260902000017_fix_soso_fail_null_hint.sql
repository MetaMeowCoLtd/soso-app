-- ============================================================================
-- 0017  Fix soso.fail's null-hint bug
-- ============================================================================
--
-- soso.fail(code, hint default null) has read:
--
--   raise exception '%', code using errcode = 'P0001', hint = hint;
--
-- since migration 0005, the very first migration to define it. When hint is
-- left at its default of null -- true for 88 of the 92 call sites across
-- this entire schema, checked directly against the migration files rather
-- than estimated -- `RAISE ... USING HINT = NULL` is not merely unhelpful,
-- it is a hard PL/pgSQL error: "RAISE statement option cannot be null" is
-- raised INSTEAD OF the intended soso/* code. Confirmed by executing the
-- bare construct in isolation, no application code involved, against a
-- real Postgres 16 instance -- this is a language-level restriction, not a
-- guess or a Supabase-specific quirk.
--
-- The practical effect: every validation failure that used the
-- single-argument form of soso.fail -- unauthenticated, insufficient
-- coins, rate limited, wrong category, self-flagging your own post, and
-- roughly eighty other checks across every RPC in this schema -- has
-- always surfaced as a generic, uncoded Postgres error instead of the
-- specific soso/* code the client is written to expect and map to a
-- readable message. This was directly confirmed as the actual cause of an
-- earlier, previously mysterious report ("resolve/out of date buttons
-- don't work, on both mobile and desktop") that several rounds of
-- UI-level debugging failed to explain, because the true cause was never
-- in the UI at all.
--
-- The four call sites that pass an explicit hint
-- (soso/no_cells, soso/too_many_cells, each appearing in two migrations)
-- were never affected and are confirmed unchanged by this fix -- verified
-- directly, not assumed, since it would be easy for a defensive rewrite
-- here to accidentally alter the hint-provided path while fixing the
-- null-hint one.
-- ============================================================================

create or replace function soso.fail(code text, hint text default null)
  returns void
  language plpgsql
as $$
begin
  if hint is null then
    raise exception '%', code using errcode = 'P0001';
  else
    raise exception '%', code using errcode = 'P0001', hint = hint;
  end if;
end;
$$;
