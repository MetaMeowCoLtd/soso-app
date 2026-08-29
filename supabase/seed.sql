-- ============================================================================
-- Seed: category configuration
-- ============================================================================
-- This is where Soso's product behaviour actually lives. Read it as the spec.
-- ============================================================================

insert into public.post_categories (
  key, label_ja, label_en,
  default_ttl, max_ttl,
  location_precision_m, requires_proximity, proximity_radius_m,
  allows_body, body_max_length, allows_media,
  min_reputation, hourly_post_limit, is_enabled, sort_order
) values

-- Accidents, obstructions, hazards. Exact pin, must be there, hours not days.
('incident', '事故・トラブル', 'Incident',
 interval '6 hours', interval '24 hours',
 0, true, 500,
 true, 300, true,
 0, 5, true, 10),

-- Roadworks and closures. Long-lived, so a wide TTL ceiling, and no proximity
-- requirement because these are often known in advance from a notice board.
('construction', '工事情報', 'Construction',
 interval '7 days', interval '180 days',
 0, false, 500,
 true, 300, true,
 0, 5, true, 20),

-- Lost items. Long TTL, exact pin is useful and harmless.
('lost', '落とし物（なくした）', 'Lost item',
 interval '14 days', interval '60 days',
 0, false, 500,
 true, 500, true,
 0, 5, true, 30),

-- Found items. Proximity-gated: you should be at the place you found it.
('found', '落とし物（拾った）', 'Found item',
 interval '14 days', interval '60 days',
 0, true, 500,
 true, 500, true,
 0, 5, true, 40),

-- Seat availability. Enabled. Very short TTL: this is the category where
-- staleness does the most damage — a "seats open" post that outlives the truth
-- is worse than no post at all. Proximity is mandatory and the radius is
-- tight, because the obvious abuse is a competitor reporting a rival as full
-- from across town. No body text: the subtype (open / short wait / full) is
-- the entire message, and free text on a fast-moving, low-context report is
-- more surface for abuse than signal.
('seats', '空席情報', 'Seat availability',
 interval '20 minutes', interval '1 hour',
 0, true, 150,
 false, 0, false,
 0, 20, true, 50),

-- Polls. Disabled: options and votes need their own tables, and half a poll is
-- worse than none.
('poll', 'アンケート', 'Poll',
 interval '3 hours', interval '24 hours',
 0, false, 500,
 true, 200, false,
 0, 3, false, 60),

-- Official-ish local notices. Disabled for now. Raised reputation floor so this
-- cannot be used to impersonate a ward office on day one.
('news', '地域のお知らせ', 'Local notice',
 interval '30 days', interval '180 days',
 0, false, 500,
 true, 1000, true,
 50, 3, false, 70),

-- --------------------------------------------------------------------------
-- Harassment reporting. SHIPPED DISABLED.
-- --------------------------------------------------------------------------
-- The row exists so the schema, the UI and the moderation tooling are all
-- exercised, but is_enabled = false means create_post rejects it and
-- feed_delta will not serve it.
--
-- Do not flip this to true until:
--   1. a Japanese lawyer has reviewed it against 名誉毀損 (Penal Code 230) and
--      the プロバイダ責任制限法 notice-and-takedown obligations
--   2. someone is on the hook to action takedowns within 24 hours
--   3. the aggregate-only display path is built (individual pins never shown)
--
-- Note the configuration: no body text, no media, 250 m location fuzzing, a
-- 6 hour TTL and mandatory proximity. Free text and photos are how a safety
-- feature becomes a defamation feature, so the schema does not permit them.
-- --------------------------------------------------------------------------
('harassment', '迷惑行為', 'Harassment',
 interval '6 hours', interval '12 hours',
 250, true, 300,
 false, 0, false,
 10, 2, false, 80);


insert into public.post_subtypes (category_key, key, label_ja, label_en, sort_order) values
  ('incident', 'traffic_accident', '交通事故',   'Traffic accident',  10),
  ('incident', 'road_hazard',      '道路の危険', 'Road hazard',       20),
  ('incident', 'crowding',         '混雑',       'Crowding',          30),
  ('incident', 'outage',           '停電・断水', 'Utility outage',     40),

  ('construction', 'road_closure',  '通行止め',   'Road closure',      10),
  ('construction', 'lane_closure',  '車線規制',   'Lane restriction',  20),
  ('construction', 'building_work', '建築工事',   'Building work',     30),

  ('seats', 'seats_open',  '空席あり',   'Seats available', 10),
  ('seats', 'short_wait',  '待ち時間少', 'Short wait',      20),
  ('seats', 'full',        '満席',       'Full',            30),

  ('news', 'rule_change',  'ルール変更', 'Rule change',     10),
  ('news', 'event',        'イベント',   'Event',           20),
  ('news', 'facility',     '施設情報',   'Facility notice', 30),

  ('harassment', 'unwanted_contact',   '接触',   'Unwanted contact', 10),
  ('harassment', 'unwanted_filming',   '盗撮',   'Filming',          20),
  ('harassment', 'following',          'つきまとい', 'Following',    30);
