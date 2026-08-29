-- ============================================================================
-- 0003  Core tables
-- ============================================================================
--
-- THE CENTRAL DESIGN DECISION
-- ---------------------------
-- There is ONE posts table, not one per feature. An incident report, a lost
-- wallet, a "3 seats free" note, a poll and a local notice are the same object:
--
--     something is true, at a place, until a time.
--
-- What differs between them is configuration, and configuration lives in the
-- `post_categories` TABLE, not in application code. Consequences:
--
--   * adding "seat availability" is an INSERT, not a deploy
--   * turning off the harassment category during a legal review is an UPDATE
--   * the TTL, the fuzzing radius and the proximity rule cannot drift between
--     client and server, because only the server has them
--
-- If you find yourself adding a `posts_lost_and_found` table, stop. Add a row.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- profiles
-- ----------------------------------------------------------------------------
-- Mirrors auth.users. Deliberately thin: everything here is world-readable, so
-- nothing sensitive goes in this table.
-- ----------------------------------------------------------------------------
create table public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  handle        text unique not null check (handle ~ '^[a-z0-9_]{3,20}$'),
  display_name  text not null check (length(display_name) between 1 and 40),

  -- Gates what the user may post. Raised by confirmed reports, lowered by
  -- upheld moderation actions. Never exposed as a public score; it is an
  -- anti-abuse input, not a leaderboard.
  reputation    integer not null default 0,

  is_moderator  boolean not null default false,
  banned_until  timestamptz,

  created_at    timestamptz not null default now()
);


-- ----------------------------------------------------------------------------
-- post_categories  -- the configuration table
-- ----------------------------------------------------------------------------
create table public.post_categories (
  key                 text primary key check (key ~ '^[a-z_]{2,24}$'),
  label_ja            text not null,
  label_en            text not null,

  -- Lifetime. `default_ttl` is applied when the client does not ask for one;
  -- `max_ttl` is the ceiling the client may request. A seat report that lives
  -- for a week is worse than no seat report at all.
  default_ttl         interval not null,
  max_ttl             interval not null,

  -- Location handling. 0 = exact pin.
  location_precision_m integer not null default 0 check (location_precision_m >= 0),

  -- Anti-abuse. If true, the poster's device must actually be near the place
  -- they are posting about. This is the main defence against remote spam and
  -- against businesses reporting each other as full.
  requires_proximity  boolean not null default false,
  proximity_radius_m  integer not null default 300 check (proximity_radius_m > 0),

  allows_body         boolean not null default true,
  body_max_length     integer not null default 500,
  allows_media        boolean not null default true,

  min_reputation      integer not null default 0,
  hourly_post_limit   integer not null default 10 check (hourly_post_limit > 0),

  -- The kill switch. A disabled category rejects new posts immediately and its
  -- existing posts stop being served. No deploy required.
  is_enabled          boolean not null default true,

  sort_order          integer not null default 0,

  constraint ttl_ordering check (max_ttl >= default_ttl)
);

comment on table public.post_categories is
  'Per-category behaviour. Server-authoritative: clients read this for UI but never enforce it.';


create table public.post_subtypes (
  category_key  text not null references public.post_categories (key) on delete cascade,
  key           text not null check (key ~ '^[a-z_]{2,32}$'),
  label_ja      text not null,
  label_en      text not null,
  is_enabled    boolean not null default true,
  sort_order    integer not null default 0,
  primary key (category_key, key)
);


-- ----------------------------------------------------------------------------
-- posts
-- ----------------------------------------------------------------------------
create type public.post_status as enum (
  'live',      -- visible
  'hidden',    -- auto-hidden pending review (dispute threshold, classifier)
  'removed'    -- moderator removed. Row is KEPT as a tombstone; see below.
);

create table public.posts (
  id            uuid primary key default extensions.gen_random_uuid(),
  author_id     uuid not null references public.profiles (id) on delete cascade,

  category_key  text not null references public.post_categories (key),
  subtype_key   text,

  body          text,
  geom          extensions.geography(Point, 4326) not null,

  -- Denormalised from geom by trigger. See 0002 for why this is an integer.
  cell_id       integer not null,

  status        public.post_status not null default 'live',
  expires_at    timestamptz not null,

  confirm_count integer not null default 0,
  dispute_count integer not null default 0,

  created_at    timestamptz not null default now(),

  -- The delta cursor. Bumped by trigger on EVERY write, including status
  -- changes, which is what makes removals visible to incremental clients.
  updated_at    timestamptz not null default now(),

  foreign key (category_key, subtype_key)
    references public.post_subtypes (category_key, key)
);

-- Rows are never hard-deleted. A DELETE would be invisible to a client holding
-- a cursor, so it could never drop the pin from its map. Status changes to
-- 'removed' instead and the row stays as a tombstone. Enforced in 0004 by
-- simply never granting DELETE.

-- The hot path. Everything the viewport query filters on, in filter order.
create index posts_viewport_idx
  on public.posts (cell_id, updated_at desc)
  include (category_key, expires_at, status);

-- Incremental fetch across the whole subscribed cell set.
create index posts_cursor_idx
  on public.posts (updated_at desc);

-- Rate limiting and "my posts".
create index posts_author_idx
  on public.posts (author_id, created_at desc);

-- Kept for radius queries (nearest-first lists, proximity checks).
create index posts_geom_idx
  on public.posts using gist (geom);


-- ----------------------------------------------------------------------------
-- Triggers: derived columns
-- ----------------------------------------------------------------------------
-- cell_id could be a GENERATED column, but that requires every function in the
-- expression to be provably IMMUTABLE across PostGIS versions. A trigger has no
-- such requirement and cannot be bypassed by normal DML, so we take the boring
-- option.
-- ----------------------------------------------------------------------------
create or replace function soso.tg_posts_derive()
  returns trigger
  language plpgsql
as $$
begin
  new.cell_id   := soso.cell_of(new.geom);
  new.updated_at := now();
  return new;
end;
$$;

create trigger posts_derive
  before insert or update on public.posts
  for each row execute function soso.tg_posts_derive();


-- ----------------------------------------------------------------------------
-- post_votes  -- corroboration, not popularity
-- ----------------------------------------------------------------------------
-- +1 "I can see this too", -1 "this is not true". Used to surface and to
-- auto-hide, never displayed as a score.
-- ----------------------------------------------------------------------------
create table public.post_votes (
  post_id    uuid not null references public.posts (id) on delete cascade,
  voter_id   uuid not null references public.profiles (id) on delete cascade,
  vote       smallint not null check (vote in (-1, 1)),
  created_at timestamptz not null default now(),
  primary key (post_id, voter_id)
);


-- ----------------------------------------------------------------------------
-- post_media
-- ----------------------------------------------------------------------------
-- Objects live in Cloudflare R2, not Supabase Storage: R2 has no egress fee and
-- images dominate egress once they exist. We store only the key.
-- ----------------------------------------------------------------------------
create table public.post_media (
  id          uuid primary key default extensions.gen_random_uuid(),
  post_id     uuid not null references public.posts (id) on delete cascade,
  object_key  text not null,
  width       integer not null check (width > 0),
  height      integer not null check (height > 0),
  ord         smallint not null default 0,
  created_at  timestamptz not null default now()
);

create index post_media_post_idx on public.post_media (post_id, ord);


-- ----------------------------------------------------------------------------
-- moderation_reports
-- ----------------------------------------------------------------------------
-- Apple guideline 1.2 requires an in-app reporting mechanism and a response
-- process for user-generated content. This table is that process. It is not
-- optional and it is not a v2 feature.
-- ----------------------------------------------------------------------------
create type public.report_reason as enum (
  'false_information', 'harassment', 'privacy', 'spam', 'illegal', 'other'
);

create table public.moderation_reports (
  id           uuid primary key default extensions.gen_random_uuid(),
  post_id      uuid not null references public.posts (id) on delete cascade,
  reporter_id  uuid not null references public.profiles (id) on delete cascade,
  reason       public.report_reason not null,
  detail       text check (detail is null or length(detail) <= 1000),
  created_at   timestamptz not null default now(),

  resolved_at  timestamptz,
  resolved_by  uuid references public.profiles (id),
  resolution   text,

  unique (post_id, reporter_id)
);

create index moderation_reports_open_idx
  on public.moderation_reports (created_at)
  where resolved_at is null;


-- ----------------------------------------------------------------------------
-- cell_subscriptions  -- push fan-out
-- ----------------------------------------------------------------------------
-- The client subscribes to an FCM topic per cell and the server publishes to
-- one topic per post, so notification cost does not scale with subscriber
-- count. This table exists so the server can render digests and so a user can
-- manage their areas across devices; it is NOT on the delivery hot path.
-- ----------------------------------------------------------------------------
create table public.cell_subscriptions (
  id          uuid primary key default extensions.gen_random_uuid(),
  user_id     uuid not null references public.profiles (id) on delete cascade,
  cell_id     integer not null,
  label       text not null check (length(label) between 1 and 40),
  categories  text[] not null default '{}',   -- empty = all
  created_at  timestamptz not null default now(),
  unique (user_id, cell_id)
);

create index cell_subscriptions_cell_idx on public.cell_subscriptions (cell_id);
