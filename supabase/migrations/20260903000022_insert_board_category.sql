-- ============================================================================
-- 0022  Insert the `board` category row — it was never actually applied
-- ============================================================================
--
-- `select key, is_enabled from post_categories where key = 'board'` returned
-- zero rows on a real deployment, which is a different and more fundamental
-- problem than 20260903000021_enable_board_category.sql assumed. That
-- migration is an UPDATE, written on the assumption that the row already
-- existed and only its `is_enabled` flag needed to change — an assumption
-- that held for every OTHER category flip this codebase has done, because
-- every other category has existed in `post_categories` since the project's
-- original seed. `board` is the first category ever ADDED to `seed.sql`
-- after a real project already existed, and that turns out not to work the
-- way editing `seed.sql` normally implies it would:
--
--   `seed.sql` is not part of the migration chain. `supabase db push` never
--   touches it. `db push --include-seed` only re-runs it alongside a
--   migration it is actively applying in that same invocation (see this
--   repo's own README on that flag) — and even then, seed.sql's plain
--   `insert into post_categories (...) values (...)`, with no `on conflict`
--   clause, would fail outright against an already-seeded database the
--   moment it hit any category row that already exists. There is no path by
--   which a row added to seed.sql after initial setup reaches an
--   already-live project. Only a real migration can do that, which is what
--   this one is.
--
-- Written as an upsert rather than a plain INSERT specifically so it is safe
-- regardless of which of the three states a given database is actually in
-- right now (unlike 0021's UPDATE, which was silently a no-op in the "row
-- doesn't exist" case with no error to signal that):
--   - row missing entirely           -> inserted, matching seed.sql's values
--   - row exists, is_enabled = false -> flipped to true, nothing else touched
--   - row exists, already enabled    -> no-op
--
-- Deliberately does NOT touch every other column on conflict (only
-- is_enabled) — overwriting the rest would clobber any value a moderator
-- might already have hand-tuned directly against a live database, which is
-- exactly the kind of change this migration has no business making.
-- ============================================================================

insert into public.post_categories (
  key, label_ja, label_en,
  default_ttl, max_ttl,
  location_precision_m, requires_proximity, proximity_radius_m,
  allows_body, body_max_length, allows_media,
  min_reputation, hourly_post_limit, is_enabled, sort_order
) values (
  'board', 'お絵かきボード', 'Board',
  interval '7 days', interval '180 days',
  0, false, 500,
  true, 300, false,
  0, 5, true, 90
)
on conflict (key) do update
  set is_enabled = true;
