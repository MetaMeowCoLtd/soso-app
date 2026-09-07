-- ============================================================================
-- 0030  "thought" — the Feed tab gets a content source again
-- ============================================================================
--
-- Migration 0027 flipped "update" from location-optional to
-- location-required, so it could render as a map pin instead of silently
-- discarding the point it was dropped at. That migration's own comment
-- was explicit about the fallout: "update" was the ONLY location-optional
-- category, so `list_feed_posts` (which selects `where cell_id is null`)
-- was left with nothing to return, and the Feed tab's compose button was
-- removed because it always created a doomed, location-less "update" post.
--
-- This is the other half of that trade: a NEW category, "thought", takes
-- over the location-optional role "update" no longer plays. It is a fresh
-- key rather than a second `is_enabled` flip on "update" for one reason —
-- "update" now means something else (a located, pinned category) to
-- every reader of this schema and to `page.tsx`'s own sentinel checks
-- (`previewingPin`, `viewingThought`), and reusing the same key for two
-- different meanings across the schema's history is exactly the kind of
-- thing that reads correctly today and confusingly in six months. The
-- name itself already existed everywhere else — `ThoughtComposer`,
-- `ThoughtThread`, and page.tsx's `viewingThought` variable all predate
-- this migration and were always describing this concept, just pointed at
-- the wrong key.
--
-- Behaviourally this is what "update" was before 0027: no lng/lat, no
-- cell, no proximity check, no zone-based audience inheritance — a short
-- text post closer to a Threads or Twitter post than a map pin, reachable
-- only through the Feed tab's own composer, never through the map's
-- drop-a-pin flow.
-- ============================================================================

insert into public.post_categories (
  key, label_ja, label_en,
  default_ttl, max_ttl,
  location_precision_m, requires_proximity, proximity_radius_m,
  allows_body, body_max_length, allows_media,
  min_reputation, hourly_post_limit, is_enabled, sort_order,
  requires_location
) values
('thought', 'つぶやき', 'Thought',
 interval '180 days', interval '180 days',
 0, false, 500,
 true, 280, true,
 0, 20, true, 100,
 false);
