-- ============================================================================
-- 0027  "update" posts carry a location
-- ============================================================================
--
-- Reverses the one decision migration 0023 made about this category: an
-- update was location-OPTIONAL, and in practice that meant location-less,
-- because `create_post` discards lng/lat outright for any category with
-- requires_location = false. Choosing "Update" in the map composer
-- therefore threw away the point the user had just dropped, produced no
-- pin, and filed the post in the feed instead — which is the behaviour
-- this migration exists to end.
--
-- The two halves of that are the same switch, which is worth being
-- explicit about because it is not obvious from the outside:
--
--   * `create_post` only geocodes, snaps, zone-matches and assigns
--     `cell_id` when `requires_location` is true. Flipping it is what
--     gives an update a cell, and a cell is what puts a pin on the map.
--   * `list_feed_posts` selects `where cell_id is null` — deliberately,
--     see its own comment in 0023: the feed is "posts that would be
--     meaningless on the map". So the moment updates have cells they stop
--     being feed posts, with no change to that function at all.
--
-- CONSEQUENCE, STATED RATHER THAN DISCOVERED LATER
-- ---------------------------------------------------------------------
-- `update` was the ONLY category with requires_location = false. After
-- this migration no enabled category is location-optional, so
-- `list_feed_posts` returns nothing and the app's Feed tab has no content
-- source. The function, the tab, and the client's cursor pagination are
-- all left in place and working — they are simply unfed. Whatever the feed
-- is meant to show next is a product decision, not something this
-- migration should guess at by quietly widening the query.
--
-- Proximity stays OFF (requires_proximity = false): an update is "here is
-- something about this place", not "I am standing here right now", so it
-- can be posted about a spot the author is not currently at. That is the
-- one location rule this does NOT tighten.
-- ============================================================================

-- EXISTING ROWS ARE LEFT ALONE, DELIBERATELY
-- ---------------------------------------------------------------------
-- Updates posted before this migration have no lng/lat and therefore no
-- cell, and there is no honest way to give them one: the location was
-- never collected, so any backfill would be inventing a place for someone
-- else's post. They keep behaving as they always have — feed-only, no pin
-- — until their TTL expires them (180 days). So the feed is not
-- immediately empty on an existing database; it drains.
update public.post_categories
   set requires_location = true
 where key = 'update';

comment on column public.post_categories.requires_location is
  'False lets a post exist with no lng/lat and therefore no cell_id, which is '
  'what list_feed_posts selects on. No enabled category sets this false as of '
  'migration 0027 — "update", the only one that did, now takes a location and '
  'renders as a map pin.';
