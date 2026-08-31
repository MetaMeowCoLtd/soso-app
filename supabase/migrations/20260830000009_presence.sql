-- ============================================================================
-- 0009  Social graph and presence
-- ============================================================================
--
-- THE PRIVACY MODEL, WHICH DRIVES EVERY DECISION BELOW
-- -----------------------------------------------------
-- Until this migration, Soso published locations of *reports*, never of
-- *people*. Presence inverts that, so it is built to give away as little as
-- possible while still making an area feel inhabited:
--
--   1. Presence is opt-in and off by default. A user who never enables it has
--      no row in `presence` at all. They do not appear as "offline"; they do
--      not appear.
--   2. Strangers see a COUNT for a coarse area, never a roster. There is no
--      query in this file that returns a stranger's identity alongside a
--      location.
--   3. Individual online status is visible only between users who follow each
--      other in BOTH directions. A one-way follow reveals nothing.
--   4. Presence is coarse: a ward-sized cell (see soso.area_cell_of), not the
--      ~1km cell the map and push notifications use.
--   5. Presence expires. A row older than the window is simply not "online",
--      so "went dark at 23:00 every night" is not inferable from a stale row.
--   6. Blocks are enforced on every read path here, not just in the UI.
--
-- The count deliberately includes the caller. A count of 1 means "you are the
-- only one here", which is a true and harmless statement; it attaches no
-- identity to anyone.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- The area grid
-- ----------------------------------------------------------------------------
-- A separate, coarser grid from the ~1km `soso.cell_of` used for the map and
-- push. At zoom 13 a cell is roughly 4km x 4km in Tokyo (~16 km2), which is
-- close to the size of a Tokyo special ward and far too coarse to place
-- someone at a street.
--
-- COLLISION HAZARD, READ BEFORE USING: this packs with the same
-- `soso.cell_pack` as the zoom-15 grid, so a zoom-13 id and a zoom-15 id can
-- be the same integer while meaning entirely different places. The two are
-- never interchangeable. Area cells live only in `presence.area_cell`; post
-- cells live only in `posts.cell_id`. Never join or compare the two.
-- ----------------------------------------------------------------------------
create or replace function soso.area_zoom()
  returns integer
  language sql
  immutable
  parallel safe
as $$ select 13 $$;

comment on function soso.area_zoom() is
  'Coarse presence grid zoom. Mirrored by AREA_ZOOM in packages/core/src/domain/grid.ts. Not interchangeable with soso.cell_zoom().';

create or replace function soso.area_cell_of(lng double precision, lat double precision)
  returns integer
  language sql
  immutable
  parallel safe
as $$
  with p as (
    select
      (1 << soso.area_zoom())::double precision                as n,
      radians(least(85.05112878, greatest(-85.05112878, lat)))  as lat_rad
  )
  select soso.cell_pack(
    least(greatest(floor(((lng + 180.0) / 360.0) * p.n)::integer, 0), p.n::integer - 1),
    least(greatest(floor(
      (1.0 - ln(tan(p.lat_rad) + 1.0 / cos(p.lat_rad)) / pi()) / 2.0 * p.n
    )::integer, 0), p.n::integer - 1)
  )
  from p;
$$;


-- How recently a heartbeat must have arrived for someone to count as online.
create or replace function soso.presence_window()
  returns interval
  language sql
  immutable
as $$ select interval '5 minutes' $$;


-- ----------------------------------------------------------------------------
-- follows
-- ----------------------------------------------------------------------------
-- A one-way edge. Friendship, and therefore presence visibility, requires both
-- directions to exist. A one-way follow is deliberately near-useless: it does
-- not reveal presence and does not notify the followee, so it cannot be used
-- to probe whether someone is around.
-- ----------------------------------------------------------------------------
create table public.follows (
  follower_id  uuid not null references public.profiles (id) on delete cascade,
  followee_id  uuid not null references public.profiles (id) on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (follower_id, followee_id),
  constraint no_self_follow check (follower_id <> followee_id)
);

create index follows_followee_idx on public.follows (followee_id);


-- ----------------------------------------------------------------------------
-- blocks
-- ----------------------------------------------------------------------------
-- A block is one-directional in intent but symmetric in effect: neither party
-- sees the other's presence, and neither can follow the other. Blocking also
-- tears down any existing follow edges (see block_user), so a block cannot be
-- silently undone by a stale follow row.
-- ----------------------------------------------------------------------------
create table public.blocks (
  blocker_id  uuid not null references public.profiles (id) on delete cascade,
  blocked_id  uuid not null references public.profiles (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  constraint no_self_block check (blocker_id <> blocked_id)
);

create index blocks_blocked_idx on public.blocks (blocked_id);


-- ----------------------------------------------------------------------------
-- presence
-- ----------------------------------------------------------------------------
-- One row per user, and ONLY for users who have opted in. The row's existence
-- is itself the opt-in signal; disabling sharing deletes it rather than
-- setting a flag, so there is no residual record of someone having once been
-- somewhere.
--
-- Note what is absent: no coordinates, no post history link, no device id.
-- Just a coarse area and a timestamp.
-- ----------------------------------------------------------------------------
create table public.presence (
  user_id       uuid primary key references public.profiles (id) on delete cascade,
  area_cell     integer not null,
  last_seen_at  timestamptz not null default now()
);

create index presence_area_idx on public.presence (area_cell, last_seen_at desc);


-- ----------------------------------------------------------------------------
-- Helpers
-- ----------------------------------------------------------------------------
create or replace function soso.is_mutual_follow(a uuid, b uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select exists (select 1 from public.follows where follower_id = a and followee_id = b)
     and exists (select 1 from public.follows where follower_id = b and followee_id = a);
$$;

create or replace function soso.is_blocked_pair(a uuid, b uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.blocks
    where (blocker_id = a and blocked_id = b)
       or (blocker_id = b and blocked_id = a)
  );
$$;


-- ----------------------------------------------------------------------------
-- Row level security
-- ----------------------------------------------------------------------------
alter table public.follows  enable row level security;
alter table public.blocks   enable row level security;
alter table public.presence enable row level security;

-- You can see who you follow and who follows you, nothing else. Notably this
-- does NOT let anyone enumerate another user's follower list.
create policy follows_read_own on public.follows
  for select to authenticated
  using (follower_id = auth.uid() or followee_id = auth.uid());

-- Blocks are private to the blocker. The blocked party is never told.
create policy blocks_read_own on public.blocks
  for select to authenticated
  using (blocker_id = auth.uid());

-- The core privacy rule, enforced in the database rather than the client:
-- a presence row is visible to its owner, and to mutual follows who are not
-- blocked. To everyone else it does not exist.
create policy presence_read_mutual on public.presence
  for select to authenticated
  using (
    user_id = auth.uid()
    or (
      soso.is_mutual_follow(auth.uid(), user_id)
      and not soso.is_blocked_pair(auth.uid(), user_id)
    )
  );

revoke all on public.follows, public.blocks, public.presence from anon, authenticated;
grant select on public.follows, public.blocks, public.presence to authenticated;


-- ----------------------------------------------------------------------------
-- Presence writes
-- ----------------------------------------------------------------------------
-- `presence_heartbeat` both opts in and refreshes. There is no separate
-- "enable" call: the client calls this on an interval only while the user has
-- the toggle on, and calls `stop_sharing_presence` when they turn it off. That
-- keeps the server's model simple (a row means "sharing, as of last_seen_at")
-- and means an abandoned tab stops counting as present without any explicit
-- sign-off.
-- ----------------------------------------------------------------------------
create or replace function public.presence_heartbeat(
  p_lng double precision,
  p_lat double precision
)
  returns void
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_uid  uuid := auth.uid();
  v_cell integer;
begin
  if v_uid is null then
    perform soso.fail('soso/unauthenticated');
  end if;

  if p_lng is null or p_lat is null
     or p_lng < -180 or p_lng > 180 or p_lat < -85 or p_lat > 85 then
    perform soso.fail('soso/invalid_location');
  end if;

  v_cell := soso.area_cell_of(p_lng, p_lat);

  insert into public.presence (user_id, area_cell, last_seen_at)
  values (v_uid, v_cell, now())
  on conflict (user_id) do update
    set area_cell = excluded.area_cell,
        last_seen_at = excluded.last_seen_at;
end;
$$;

create or replace function public.stop_sharing_presence()
  returns void
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    perform soso.fail('soso/unauthenticated');
  end if;
  -- Deleted, not flagged. Nothing should remain that says where this person
  -- was when they stopped sharing.
  delete from public.presence where user_id = auth.uid();
end;
$$;


-- ----------------------------------------------------------------------------
-- area_presence_count
-- ----------------------------------------------------------------------------
-- The "this place is alive" number, and the only presence query a stranger can
-- run. SECURITY DEFINER because it must aggregate over rows the caller cannot
-- see individually; it returns a single integer and never a user id, so it
-- cannot be used to enumerate anyone.
--
-- Blocked users are excluded from the caller's count, so a blocked party
-- cannot even contribute to a number the blocker sees.
-- ----------------------------------------------------------------------------
create or replace function public.area_presence_count(p_area_cell integer)
  returns integer
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select count(*)::integer
  from public.presence p
  where p.area_cell = p_area_cell
    and p.last_seen_at > now() - soso.presence_window()
    and not soso.is_blocked_pair(coalesce(auth.uid(), p.user_id), p.user_id);
$$;


-- ----------------------------------------------------------------------------
-- friends_presence
-- ----------------------------------------------------------------------------
-- The mutual-follow list with online status. This is the only path that pairs
-- an identity with presence information, and it requires a reciprocal follow
-- and the absence of a block on either side.
--
-- `same_area` is deliberately a boolean rather than the area cell itself: a
-- friend learns "nearby or not", not which ward you are in.
-- ----------------------------------------------------------------------------
create or replace function public.friends_presence()
  returns table (
    user_id      uuid,
    handle       text,
    display_name text,
    is_online    boolean,
    last_seen_at timestamptz,
    same_area    boolean
  )
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  with me as (
    select auth.uid() as id
  ),
  my_area as (
    select p.area_cell
    from public.presence p, me
    where p.user_id = me.id
      and p.last_seen_at > now() - soso.presence_window()
  ),
  mutuals as (
    select f.followee_id as id
    from public.follows f, me
    where f.follower_id = me.id
      and exists (
        select 1 from public.follows b
        where b.follower_id = f.followee_id and b.followee_id = me.id
      )
  )
  select
    pr.id,
    pr.handle,
    pr.display_name,
    (p.last_seen_at is not null and p.last_seen_at > now() - soso.presence_window()) as is_online,
    case
      when p.last_seen_at > now() - soso.presence_window() then p.last_seen_at
      else null
    end as last_seen_at,
    coalesce(
      p.area_cell is not null
      and p.last_seen_at > now() - soso.presence_window()
      and p.area_cell = (select area_cell from my_area),
      false
    ) as same_area
  from mutuals m
  join public.profiles pr on pr.id = m.id
  left join public.presence p on p.user_id = m.id
  where not soso.is_blocked_pair((select id from me), m.id)
  order by is_online desc, pr.display_name;
$$;


-- ----------------------------------------------------------------------------
-- Social graph writes
-- ----------------------------------------------------------------------------
-- Following is by handle, not by browsing. There is no "people near you" list
-- to follow from, on purpose: discovery happens because someone gave you their
-- handle, which keeps the graph intentional rather than proximity-harvested.
-- ----------------------------------------------------------------------------
create or replace function public.follow_by_handle(p_handle text)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_uid    uuid := auth.uid();
  v_target public.profiles;
begin
  if v_uid is null then
    perform soso.fail('soso/unauthenticated');
  end if;

  select * into v_target from public.profiles where handle = lower(trim(p_handle));
  if not found then
    perform soso.fail('soso/user_not_found');
  end if;
  if v_target.id = v_uid then
    perform soso.fail('soso/cannot_follow_self');
  end if;
  if soso.is_blocked_pair(v_uid, v_target.id) then
    -- Deliberately the same error as "no such user". Telling someone they have
    -- been blocked is itself information they can act on.
    perform soso.fail('soso/user_not_found');
  end if;

  insert into public.follows (follower_id, followee_id)
  values (v_uid, v_target.id)
  on conflict do nothing;

  return jsonb_build_object(
    'id',        v_target.id,
    'handle',    v_target.handle,
    'name',      v_target.display_name,
    'mutual',    soso.is_mutual_follow(v_uid, v_target.id)
  );
end;
$$;

create or replace function public.unfollow_user(p_user_id uuid)
  returns void
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    perform soso.fail('soso/unauthenticated');
  end if;
  delete from public.follows
  where follower_id = auth.uid() and followee_id = p_user_id;
end;
$$;

create or replace function public.block_user(p_user_id uuid)
  returns void
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    perform soso.fail('soso/unauthenticated');
  end if;
  if p_user_id = v_uid then
    perform soso.fail('soso/cannot_block_self');
  end if;

  insert into public.blocks (blocker_id, blocked_id)
  values (v_uid, p_user_id)
  on conflict do nothing;

  -- Tear down the relationship in both directions. Leaving follow rows in
  -- place would mean unblocking silently restores mutual visibility, which is
  -- not what anyone expects a block to do.
  delete from public.follows
  where (follower_id = v_uid and followee_id = p_user_id)
     or (follower_id = p_user_id and followee_id = v_uid);
end;
$$;

create or replace function public.unblock_user(p_user_id uuid)
  returns void
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    perform soso.fail('soso/unauthenticated');
  end if;
  delete from public.blocks
  where blocker_id = auth.uid() and blocked_id = p_user_id;
end;
$$;


-- ----------------------------------------------------------------------------
-- my_profile
-- ----------------------------------------------------------------------------
-- Your own handle, so you can share it with someone who wants to add you.
-- ----------------------------------------------------------------------------
create or replace function public.my_profile()
  returns jsonb
  language sql
  stable
  security invoker
  set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id',     p.id,
    'handle', p.handle,
    'name',   p.display_name
  )
  from public.profiles p
  where p.id = auth.uid();
$$;


grant execute on function public.presence_heartbeat(double precision, double precision) to authenticated;
grant execute on function public.stop_sharing_presence() to authenticated;
grant execute on function public.area_presence_count(integer) to anon, authenticated;
grant execute on function public.friends_presence() to authenticated;
grant execute on function public.follow_by_handle(text) to authenticated;
grant execute on function public.unfollow_user(uuid) to authenticated;
grant execute on function public.block_user(uuid) to authenticated;
grant execute on function public.unblock_user(uuid) to authenticated;
grant execute on function public.my_profile() to authenticated;
