-- ============================================================================
-- 0010  Private pins, friend tiers, and shared zones
-- ============================================================================
--
-- Three related additions, built on the mutual-follow friendship model from
-- migration 0009 rather than a parallel one:
--
--   1. Friend tiers. A friendship (mutual follow) can be marked "close" by
--      either side. Tier is stored per-direction on `follows`, so it is a
--      private judgement: marking someone close is not visible to them, and
--      does not require them to reciprocate.
--
--   2. Post audiences. A post is public, friends-only, close-friends-only, or
--      restricted to a hand-picked list.
--
--   3. Zones. A named circular area whose pins are automatically shared with
--      one audience, so someone posting inside their neighbourhood group does
--      not have to pick an audience every time.
--
-- THE SECURITY-CRITICAL PART
-- --------------------------
-- `feed_delta`, `cell_counts` and `post_detail` are SECURITY DEFINER, which
-- means RLS on `posts` does not constrain them. Every one of them must apply
-- `soso.can_see_post` itself. A private pin leaking through a read path that
-- forgot the predicate is the worst failure this feature can have, so the
-- predicate lives in exactly one function and every read path calls it. Do not
-- inline the logic anywhere.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- Friend tiers
-- ----------------------------------------------------------------------------
-- On `follows` rather than a separate table: the tier is a property of one
-- person's view of another, which is exactly what a follow edge already is.
-- ----------------------------------------------------------------------------
create type public.friend_tier as enum ('close', 'standard');

alter table public.follows
  add column tier public.friend_tier not null default 'standard';

comment on column public.follows.tier is
  'How the follower classifies the followee. Private to the follower; never exposed to the followee.';


-- ----------------------------------------------------------------------------
-- Post audiences
-- ----------------------------------------------------------------------------
create type public.post_audience as enum ('public', 'friends', 'close_friends', 'custom');

alter table public.posts
  add column audience public.post_audience not null default 'public';

-- Explicit recipients, used only when audience = 'custom'. Rows are kept for
-- every audience type would be wasteful, so this is populated selectively.
create table public.post_recipients (
  post_id  uuid not null references public.posts (id) on delete cascade,
  user_id  uuid not null references public.profiles (id) on delete cascade,
  primary key (post_id, user_id)
);

create index post_recipients_user_idx on public.post_recipients (user_id);

-- The viewport query filters on audience constantly, and the overwhelmingly
-- common case is 'public'. A partial index keeps that path as fast as it was
-- before this feature existed.
create index posts_public_viewport_idx
  on public.posts (cell_id, updated_at desc)
  where audience = 'public' and status = 'live';


-- ----------------------------------------------------------------------------
-- Zones
-- ----------------------------------------------------------------------------
-- A circle, not a polygon. A polygon editor is a significant piece of UI, and
-- a centre plus radius covers "my neighbourhood" and "our campus" while being
-- something a user can define with two gestures. `radius_m` is capped so a
-- zone cannot be drawn around an entire city and quietly become a public feed.
-- ----------------------------------------------------------------------------
create table public.zones (
  id          uuid primary key default extensions.gen_random_uuid(),
  owner_id    uuid not null references public.profiles (id) on delete cascade,
  name        text not null check (length(trim(name)) between 1 and 40),
  centre      extensions.geography(Point, 4326) not null,
  radius_m    integer not null check (radius_m between 100 and 5000),
  audience    public.post_audience not null default 'friends',
  created_at  timestamptz not null default now()
);

create index zones_owner_idx on public.zones (owner_id);
create index zones_centre_idx on public.zones using gist (centre);

-- Members of a zone whose audience is 'custom'.
create table public.zone_members (
  zone_id  uuid not null references public.zones (id) on delete cascade,
  user_id  uuid not null references public.profiles (id) on delete cascade,
  primary key (zone_id, user_id)
);

create index zone_members_user_idx on public.zone_members (user_id);

-- Which zone (if any) a post inherited its audience from. Kept for display
-- ("shared with Shibuya crew") and so that deleting a zone does not silently
-- change who can see posts already made in it: the audience is copied onto the
-- post at write time, and this column is only a label.
alter table public.posts
  add column zone_id uuid references public.zones (id) on delete set null;


-- ----------------------------------------------------------------------------
-- soso.can_see_post
-- ----------------------------------------------------------------------------
-- The single visibility predicate. Every read path calls this.
--
-- Deliberately STABLE and SECURITY DEFINER so it can consult follows/blocks
-- regardless of the caller's own RLS, and so Postgres can cache it within a
-- statement rather than re-evaluating per row.
-- ----------------------------------------------------------------------------
create or replace function soso.can_see_post(
  p_viewer   uuid,
  p_author   uuid,
  p_audience public.post_audience,
  p_post_id  uuid
)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select case
    -- Your own posts are always visible to you, whatever the audience.
    when p_viewer is not null and p_viewer = p_author then true

    -- A block hides posts in both directions, before any audience check.
    when p_viewer is not null and soso.is_blocked_pair(p_viewer, p_author) then false

    when p_audience = 'public' then true

    -- Everything below needs a signed-in viewer. An anonymous or logged-out
    -- reader sees public posts only.
    when p_viewer is null then false

    when p_audience = 'friends' then soso.is_mutual_follow(p_viewer, p_author)

    -- Close friends: mutual follow, AND the author has marked the viewer
    -- close. The author's judgement governs, not the viewer's.
    when p_audience = 'close_friends' then
      soso.is_mutual_follow(p_viewer, p_author)
      and exists (
        select 1 from public.follows
        where follower_id = p_author and followee_id = p_viewer and tier = 'close'
      )

    when p_audience = 'custom' then
      exists (
        select 1 from public.post_recipients
        where post_id = p_post_id and user_id = p_viewer
      )

    else false
  end;
$$;


-- ----------------------------------------------------------------------------
-- soso.zone_for_point
-- ----------------------------------------------------------------------------
-- The smallest zone belonging to the author that contains a point. Smallest,
-- not first: overlapping zones are expected (a "home street" inside a
-- "neighbourhood"), and the tighter one is the more specific intent.
-- ----------------------------------------------------------------------------
create or replace function soso.zone_for_point(
  p_owner uuid,
  p_geom  extensions.geography
)
  returns public.zones
  language sql
  stable
  set search_path = public, extensions, pg_temp
as $$
  select z.*
  from public.zones z
  where z.owner_id = p_owner
    and st_dwithin(z.centre, p_geom, z.radius_m)
  order by z.radius_m asc
  limit 1;
$$;
