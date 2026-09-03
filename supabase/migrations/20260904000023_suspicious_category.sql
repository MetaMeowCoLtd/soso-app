-- ============================================================================
-- 0023  Add the `suspicious` category — SHIPPED DISABLED, same reasons as
--       `harassment`, deliberately made even more restrictive
-- ============================================================================
--
-- Written as an upsert, not a plain INSERT, for the exact reason
-- 20260903000022_insert_board_category.sql documents at length: seed.sql
-- edits never reach an already-migrated database, only a real migration
-- does. `on conflict (key) do nothing` rather than an UPDATE, because unlike
-- 0022 this category has never existed in any deployed database before —
-- there is no live row's `is_enabled` to flip, only a row that may or may
-- not exist yet depending on whether `db reset` or `db push` produced the
-- database in front of you.
--
-- --------------------------------------------------------------------------
-- Why this is shipped disabled, and why its schema is even tighter than
-- `harassment`'s
-- --------------------------------------------------------------------------
-- "Suspicious activity" reporting is a well-documented vector for
-- discriminatory profiling in exactly this product shape — a public,
-- geolocated feed where anyone can flag someone else's presence as
-- suspicious. Nextdoor's own history with this feature is the reference
-- case: reports skewed heavily toward race-coded suspicion of people doing
-- ordinary things, and the fix that actually worked was UI friction (an
-- interstitial forcing the reporter to describe behaviour, not appearance)
-- plus aggregate-only display, not just moderation after the fact.
--
-- This category is not enabled yet, and should not be enabled on the same
-- checklist as `harassment` alone -- treat it as needing everything that
-- row's comment requires (defamation-law review, a moderator on the hook
-- for 24h takedowns, aggregate-only display so individual pins are never
-- shown) PLUS a fourth item specific to this category: a decision, made
-- deliberately and not by default, about whether pins should be shown to
-- the public at all versus routed only to something like local
-- neighbourhood-watch/police liaison accounts. Shipping this to the general
-- feed the same way `incident` or `lost` work is very likely the wrong call
-- even after the other three boxes are checked.
--
-- The schema is built to make the worst version of this feature hard to
-- build by accident, mirroring and tightening `harassment`:
--   - no body text, no media at all: nothing here is a place to describe a
--     person. Subtypes below are deliberately behaviour/object-framed
--     ("unattended item", "break-in attempt", "vehicle") rather than
--     person-framed, for the same reason `harassment`'s subtypes are
--     behaviours ("following", "unwanted filming") and not identity
--     descriptors.
--   - 250m location fuzzing and mandatory proximity, same as harassment:
--     locally useful without being precise enough to point at one doorway,
--     and the reporter has to actually have been there.
--   - min_reputation 10 and a 2/hour cap: this is not a category a
--     brand-new or throwaway account should be able to use at volume.
--   - default_ttl shorter than harassment's (4h vs 6h): a "suspicious
--     activity happening right now" report is near-worthless, and
--     increasingly harmful to the person it named, the longer it persists
--     after the fact.
--
-- Deliberately NOT added to apps/web/src/web/theme.ts's `LOOK` map, matching
-- `harassment` (which also has no entry there) rather than `poll`/`news`/
-- `board` (which do, despite also being disabled). That is not an
-- oversight: `harassment` and this category are the two where the plan is
-- aggregate-only display, never a normal pin marker with its own cute icon
-- sitting on the map next to `incident` and `lost`. Giving it one now would
-- be quietly committing to the wrong display model before that decision is
-- actually made.
-- ============================================================================

insert into public.post_categories (
  key, label_ja, label_en,
  default_ttl, max_ttl,
  location_precision_m, requires_proximity, proximity_radius_m,
  allows_body, body_max_length, allows_media,
  min_reputation, hourly_post_limit, is_enabled, sort_order
) values (
  'suspicious', '不審な活動', 'Suspicious activity',
  interval '4 hours', interval '12 hours',
  250, true, 300,
  false, 0, false,
  10, 2, false, 85
)
on conflict (key) do nothing;

insert into public.post_subtypes (category_key, key, label_ja, label_en, sort_order) values
  ('suspicious', 'unattended_item',  '不審な置き去り物', 'Unattended item',    10),
  ('suspicious', 'break_in_attempt', '侵入未遂',         'Break-in attempt',   20),
  ('suspicious', 'vehicle',          '不審な車両',       'Suspicious vehicle', 30),
  ('suspicious', 'prowling',         'うろつき',         'Prowling/loitering', 40)
on conflict (category_key, key) do nothing;
