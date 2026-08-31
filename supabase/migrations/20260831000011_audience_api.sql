-- ============================================================================
-- 0011  Audience-aware API
-- ============================================================================
--
-- Rewrites every read path from 0005 to apply `soso.can_see_post`, and extends
-- the write path to accept an audience or inherit one from a zone.
--
-- Each function below is a full replacement of its 0005 counterpart. They are
-- restated in whole rather than patched so that the visibility filter is
-- readable in situ: a reviewer should be able to see the predicate in the same
-- function body as the query it guards, without cross-referencing an earlier
-- migration to check it is still there.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- soso.pin  -- now carries audience so clients can badge private pins
-- ----------------------------------------------------------------------------
create or replace function soso.pin(p public.posts)
  returns jsonb
  language sql
  stable
  parallel safe
  set search_path = public, extensions, pg_temp
as $$
  select jsonb_build_object(
    'i', p.id,
    'c', p.category_key,
    's', p.subtype_key,
    'g', jsonb_build_array(
           round(st_x(p.geom::geometry)::numeric, 6),
           round(st_y(p.geom::geometry)::numeric, 6)
         ),
    't', extract(epoch from p.created_at)::bigint,
    'x', extract(epoch from p.expires_at)::bigint,
    'n', p.confirm_count - p.dispute_count,
    'm', exists (select 1 from public.post_media m where m.post_id = p.id),
    -- One character, and only ever present for non-public posts, so the
    -- common case adds nothing to the viewport payload.
    'a', case when p.audience = 'public' then null else p.audience::text end
  );
$$;


-- ----------------------------------------------------------------------------
-- feed_delta
-- ----------------------------------------------------------------------------
create or replace function public.feed_delta(
  p_cells      integer[],
  p_since      timestamptz default null,
  p_categories text[]      default null,
  p_limit      integer     default 200
)
  returns jsonb
  language plpgsql
  stable
  security definer
  set search_path = public, extensions, pg_temp
as $$
declare
  v_viewer   uuid        := auth.uid();
  v_now      timestamptz := now();
  v_from     timestamptz := case when p_since is null then null
                                 else p_since - interval '10 seconds' end;
  v_limit    integer     := least(greatest(coalesce(p_limit, 200), 1), 500);
  v_added    jsonb;
  v_removed  jsonb;
  v_total    integer;
begin
  if p_cells is null or cardinality(p_cells) = 0 then
    perform soso.fail('soso/no_cells', 'Pass at least one cell id.');
  end if;

  if cardinality(p_cells) > 256 then
    perform soso.fail('soso/too_many_cells', 'Zoom out uses cell_counts, not feed_delta.');
  end if;

  with candidate as (
    select p.*
    from public.posts p
    join public.post_categories c on c.key = p.category_key and c.is_enabled
    where p.cell_id = any (p_cells)
      and (p_categories is null or p.category_key = any (p_categories))
      and (v_from is null or p.updated_at > v_from)
      -- THE visibility filter. Applied here, before anything else looks at
      -- these rows, so neither `added` nor `removed` can leak a post the
      -- viewer is not entitled to. A tombstone id is still an id.
      and soso.can_see_post(v_viewer, p.author_id, p.audience, p.id)
  ),
  live as (
    select * from candidate
    where status = 'live' and expires_at > v_now
    order by updated_at desc
    limit v_limit
  )
  select
    coalesce((select jsonb_agg(soso.pin(l.*)) from live l), '[]'::jsonb),
    coalesce((select jsonb_agg(c.id)
              from candidate c
              where v_from is not null
                and (c.status <> 'live' or c.expires_at <= v_now)), '[]'::jsonb),
    (select count(*)::integer from candidate
     where status = 'live' and expires_at > v_now)
  into v_added, v_removed, v_total;

  return jsonb_build_object(
    'cursor',    v_now,
    'added',     v_added,
    'removed',   v_removed,
    'truncated', v_total > v_limit
  );
end;
$$;


-- ----------------------------------------------------------------------------
-- cell_counts
-- ----------------------------------------------------------------------------
-- Was SECURITY INVOKER and relied on RLS. It is now DEFINER for the same
-- reason as the others: `can_see_post` needs to read follows and blocks, which
-- the viewer cannot select directly.
--
-- A count is a disclosure too. Excluding invisible posts here is not just
-- tidiness: a zoomed-out count that included private pins would let someone
-- infer that a friends-only post exists in a cell without being able to open
-- it.
-- ----------------------------------------------------------------------------
create or replace function public.cell_counts(
  p_cells      integer[],
  p_categories text[] default null
)
  returns table (cell_id integer, n integer)
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select p.cell_id, count(*)::integer
  from public.posts p
  join public.post_categories c on c.key = p.category_key and c.is_enabled
  where p.cell_id = any (p_cells)
    and p.status = 'live'
    and p.expires_at > now()
    and (p_categories is null or p.category_key = any (p_categories))
    and soso.can_see_post(auth.uid(), p.author_id, p.audience, p.id)
  group by p.cell_id;
$$;


-- ----------------------------------------------------------------------------
-- post_detail
-- ----------------------------------------------------------------------------
create or replace function public.post_detail(p_post_id uuid)
  returns jsonb
  language sql
  stable
  security definer
  set search_path = public, extensions, pg_temp
as $$
  select soso.pin(p.*) || jsonb_build_object(
    'body',    p.body,
    'created', p.created_at,
    'up',      p.confirm_count,
    'down',    p.dispute_count,
    'author',  jsonb_build_object(
                 'id',     a.id,
                 'handle', a.handle,
                 'name',   a.display_name
               ),
    'media',   coalesce(
                 (select jsonb_agg(
                           jsonb_build_object('key', m.object_key,
                                              'w',   m.width,
                                              'h',   m.height)
                           order by m.ord)
                  from public.post_media m where m.post_id = p.id),
                 '[]'::jsonb
               ),
    'mine',    p.author_id = auth.uid(),
    'zone',    (select z.name from public.zones z where z.id = p.zone_id)
  )
  from public.posts p
  join public.profiles a on a.id = p.author_id
  where p.id = p_post_id
    and soso.can_see_post(auth.uid(), p.author_id, p.audience, p.id);
$$;


-- ----------------------------------------------------------------------------
-- create_post  -- audience and zone inheritance
-- ----------------------------------------------------------------------------
-- The DROP is essential, not tidiness. Adding two defaulted parameters does
-- NOT replace the 0005 function: Postgres identifies functions by their full
-- argument list, so `create or replace` here would leave BOTH versions
-- present. A call that omits the new arguments would then be ambiguous, and
-- PostgREST could resolve it to the old function, which knows nothing about
-- audiences and would write every post as public. A private pin silently
-- published is the worst outcome this feature can produce, so the old
-- signature is removed outright rather than left to chance.
-- ----------------------------------------------------------------------------
drop function if exists public.create_post(
  text, double precision, double precision, text, text,
  double precision, double precision, integer
);

create or replace function public.create_post(
  p_category     text,
  p_lng          double precision,
  p_lat          double precision,
  p_subtype      text             default null,
  p_body         text             default null,
  p_device_lng   double precision default null,
  p_device_lat   double precision default null,
  p_ttl_minutes  integer          default null,
  p_audience     public.post_audience default null,
  p_recipients   uuid[]           default null
)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = public, extensions, pg_temp
as $$
declare
  v_uid       uuid := auth.uid();
  v_profile   public.profiles;
  v_cat       public.post_categories;
  v_target    extensions.geography;
  v_device    extensions.geography;
  v_ttl       interval;
  v_post      public.posts;
  v_recent    integer;
  v_zone      public.zones;
  v_audience  public.post_audience;
  v_recipient uuid;
begin
  ---------------------------------------------------------------- identity
  if v_uid is null then
    perform soso.fail('soso/unauthenticated');
  end if;

  select * into v_profile from public.profiles where id = v_uid;
  if not found then
    perform soso.fail('soso/no_profile');
  end if;
  if v_profile.banned_until is not null and v_profile.banned_until > now() then
    perform soso.fail('soso/banned');
  end if;

  ---------------------------------------------------------------- category
  select * into v_cat from public.post_categories where key = p_category;
  if not found or not v_cat.is_enabled then
    perform soso.fail('soso/category_unavailable');
  end if;
  if v_profile.reputation < v_cat.min_reputation then
    perform soso.fail('soso/reputation_too_low');
  end if;

  if p_subtype is not null then
    if not exists (
      select 1 from public.post_subtypes
      where category_key = p_category and key = p_subtype and is_enabled
    ) then
      perform soso.fail('soso/invalid_subtype');
    end if;
  end if;

  ---------------------------------------------------------------- body
  if p_body is not null and length(trim(p_body)) > 0 then
    if not v_cat.allows_body then
      perform soso.fail('soso/body_not_allowed');
    end if;
    if length(p_body) > v_cat.body_max_length then
      perform soso.fail('soso/body_too_long');
    end if;
  end if;

  ---------------------------------------------------------------- rate limit
  select count(*)::integer into v_recent
  from public.posts
  where author_id = v_uid and created_at > now() - interval '1 hour';

  if v_recent >= v_cat.hourly_post_limit then
    perform soso.fail('soso/rate_limited');
  end if;

  ---------------------------------------------------------------- location
  if p_lng is null or p_lat is null
     or p_lng < -180 or p_lng > 180 or p_lat < -85 or p_lat > 85 then
    perform soso.fail('soso/invalid_location');
  end if;

  v_target := st_point(p_lng, p_lat, 4326)::geography;

  if v_cat.requires_proximity then
    if p_device_lng is null or p_device_lat is null then
      perform soso.fail('soso/device_location_required');
    end if;
    v_device := st_point(p_device_lng, p_device_lat, 4326)::geography;
    if st_distance(v_device, v_target) > v_cat.proximity_radius_m then
      perform soso.fail('soso/too_far_away');
    end if;
  end if;

  v_target := soso.snap(v_target, v_cat.location_precision_m);

  ---------------------------------------------------------------- audience
  -- Explicit choice wins. Falling back to a zone only when the caller did not
  -- specify keeps the zone a convenience rather than something that can
  -- silently widen or narrow an audience the user deliberately picked.
  v_zone := soso.zone_for_point(v_uid, v_target);
  v_audience := coalesce(p_audience, v_zone.audience, 'public');

  if v_audience = 'custom' then
    if p_recipients is null or cardinality(p_recipients) = 0 then
      -- A custom post with nobody on the list would be invisible to everyone
      -- but its author, which is silently not what the user meant.
      perform soso.fail('soso/no_recipients');
    end if;
    if cardinality(p_recipients) > 100 then
      perform soso.fail('soso/too_many_recipients');
    end if;
  end if;

  ---------------------------------------------------------------- lifetime
  v_ttl := coalesce(
    case when p_ttl_minutes is null then null
         else make_interval(mins => greatest(p_ttl_minutes, 1)) end,
    v_cat.default_ttl
  );
  if v_ttl > v_cat.max_ttl then
    v_ttl := v_cat.max_ttl;
  end if;

  ---------------------------------------------------------------- write
  insert into public.posts (
    author_id, category_key, subtype_key, body, geom, expires_at, audience, zone_id
  )
  values (
    v_uid,
    p_category,
    p_subtype,
    nullif(trim(coalesce(p_body, '')), ''),
    v_target,
    now() + v_ttl,
    v_audience,
    case when p_audience is null then v_zone.id else null end
  )
  returning * into v_post;

  if v_audience = 'custom' then
    foreach v_recipient in array p_recipients loop
      -- Only mutual follows can be named. Otherwise "custom" would be a way
      -- to push a pin at a stranger, which is the harassment vector this
      -- whole audience model exists to avoid.
      if soso.is_mutual_follow(v_uid, v_recipient)
         and not soso.is_blocked_pair(v_uid, v_recipient) then
        insert into public.post_recipients (post_id, user_id)
        values (v_post.id, v_recipient)
        on conflict do nothing;
      end if;
    end loop;
  end if;

  return soso.pin(v_post);
end;
$$;


-- ----------------------------------------------------------------------------
-- Zone management
-- ----------------------------------------------------------------------------
create or replace function public.create_zone(
  p_name     text,
  p_lng      double precision,
  p_lat      double precision,
  p_radius_m integer,
  p_audience public.post_audience default 'friends',
  p_members  uuid[] default null
)
  returns uuid
  language plpgsql
  volatile
  security definer
  set search_path = public, extensions, pg_temp
as $$
declare
  v_uid    uuid := auth.uid();
  v_zone   public.zones;
  v_member uuid;
  v_count  integer;
begin
  if v_uid is null then perform soso.fail('soso/unauthenticated'); end if;

  if p_audience = 'public' then
    -- A "public zone" is just posting normally; allowing it would imply the
    -- zone does something it does not.
    perform soso.fail('soso/invalid_zone_audience');
  end if;

  select count(*)::integer into v_count from public.zones where owner_id = v_uid;
  if v_count >= 20 then
    perform soso.fail('soso/too_many_zones');
  end if;

  insert into public.zones (owner_id, name, centre, radius_m, audience)
  values (
    v_uid,
    trim(p_name),
    st_point(p_lng, p_lat, 4326)::geography,
    p_radius_m,
    p_audience
  )
  returning * into v_zone;

  if p_audience = 'custom' and p_members is not null then
    foreach v_member in array p_members loop
      if soso.is_mutual_follow(v_uid, v_member)
         and not soso.is_blocked_pair(v_uid, v_member) then
        insert into public.zone_members (zone_id, user_id)
        values (v_zone.id, v_member)
        on conflict do nothing;
      end if;
    end loop;
  end if;

  return v_zone.id;
end;
$$;


create or replace function public.delete_zone(p_zone_id uuid)
  returns void
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then perform soso.fail('soso/unauthenticated'); end if;
  -- Posts already made in this zone keep their audience: `zone_id` is set null
  -- by the foreign key, but `audience` was copied onto the post at write time.
  -- Deleting a zone must not retroactively expose anything.
  delete from public.zones where id = p_zone_id and owner_id = auth.uid();
end;
$$;


create or replace function public.my_zones()
  returns jsonb
  language sql
  stable
  security definer
  set search_path = public, extensions, pg_temp
as $$
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id',       z.id,
      'name',     z.name,
      'lng',      round(st_x(z.centre::geometry)::numeric, 6),
      'lat',      round(st_y(z.centre::geometry)::numeric, 6),
      'radius_m', z.radius_m,
      'audience', z.audience::text,
      'members',  (select count(*)::integer from public.zone_members m where m.zone_id = z.id)
    )
    order by z.created_at
  ), '[]'::jsonb)
  from public.zones z
  where z.owner_id = auth.uid();
$$;


-- ----------------------------------------------------------------------------
-- set_friend_tier
-- ----------------------------------------------------------------------------
create or replace function public.set_friend_tier(
  p_user_id uuid,
  p_tier    public.friend_tier
)
  returns void
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then perform soso.fail('soso/unauthenticated'); end if;
  if not soso.is_mutual_follow(v_uid, p_user_id) then
    perform soso.fail('soso/not_friends');
  end if;

  update public.follows
  set tier = p_tier
  where follower_id = v_uid and followee_id = p_user_id;
end;
$$;


-- ----------------------------------------------------------------------------
-- RLS and grants for the new tables
-- ----------------------------------------------------------------------------
alter table public.post_recipients enable row level security;
alter table public.zones enable row level security;
alter table public.zone_members enable row level security;

-- Recipients are readable only by the person named, so nobody can enumerate
-- who else a post was shared with.
create policy post_recipients_read_own on public.post_recipients
  for select to authenticated
  using (user_id = auth.uid());

create policy zones_read_own on public.zones
  for select to authenticated
  using (owner_id = auth.uid());

create policy zone_members_read on public.zone_members
  for select to authenticated
  using (
    user_id = auth.uid()
    or exists (select 1 from public.zones z where z.id = zone_id and z.owner_id = auth.uid())
  );

revoke all on public.post_recipients, public.zones, public.zone_members from anon, authenticated;
grant select on public.post_recipients, public.zones, public.zone_members to authenticated;

grant execute on function public.create_post(
  text, double precision, double precision, text, text,
  double precision, double precision, integer,
  public.post_audience, uuid[]) to authenticated;
grant execute on function public.create_zone(
  text, double precision, double precision, integer, public.post_audience, uuid[]) to authenticated;
grant execute on function public.delete_zone(uuid) to authenticated;
grant execute on function public.my_zones() to authenticated;
grant execute on function public.set_friend_tier(uuid, public.friend_tier) to authenticated;
grant execute on function public.feed_delta(integer[], timestamptz, text[], integer) to anon, authenticated;
grant execute on function public.cell_counts(integer[], text[]) to anon, authenticated;
grant execute on function public.post_detail(uuid) to anon, authenticated;


-- ----------------------------------------------------------------------------
-- can_see_post_as
-- ----------------------------------------------------------------------------
-- Visibility check on behalf of another user. Exists solely for the push Edge
-- Function, which must decide whether a given subscriber may be told a post
-- exists, and which runs as service_role rather than as that subscriber.
--
-- Deliberately NOT granted to anon or authenticated. A signed-in user calling
-- this with someone else's id would be probing another person's friend graph:
-- "can Bob see this close-friends post" answers a question about Bob's
-- relationships that Bob has not shared. service_role only.
-- ----------------------------------------------------------------------------
create or replace function public.can_see_post_as(
  p_viewer  uuid,
  p_post_id uuid
)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select coalesce(
    (select soso.can_see_post(p_viewer, p.author_id, p.audience, p.id)
     from public.posts p where p.id = p_post_id),
    false
  );
$$;

revoke execute on function public.can_see_post_as(uuid, uuid) from anon, authenticated;
grant execute on function public.can_see_post_as(uuid, uuid) to service_role;


-- ----------------------------------------------------------------------------
-- friends_presence  -- now carries the viewer's own tier for each friend
-- ----------------------------------------------------------------------------
-- Replaces the 0009 version. The only change is the added `tier` column,
-- sourced from the viewer's own outbound follow edge, so it reflects how the
-- VIEWER classifies each friend. It never exposes how the friend classifies
-- the viewer, which is deliberately private.
--
-- The explicit DROP is required, not stylistic. `create or replace function`
-- cannot change a function's return type, and adding a column to a
-- `returns table (...)` signature is exactly that: Postgres rejects it with
-- "cannot change return type of existing function" (42P13). Set-returning
-- functions must be dropped and recreated when their row type changes.
-- ----------------------------------------------------------------------------
drop function if exists public.friends_presence();

create function public.friends_presence()
  returns table (
    user_id      uuid,
    handle       text,
    display_name text,
    is_online    boolean,
    last_seen_at timestamptz,
    same_area    boolean,
    tier         public.friend_tier
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
    select f.followee_id as id, f.tier
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
    ) as same_area,
    m.tier
  from mutuals m
  join public.profiles pr on pr.id = m.id
  left join public.presence p on p.user_id = m.id
  where not soso.is_blocked_pair((select id from me), m.id)
  order by (m.tier = 'close') desc, is_online desc, pr.display_name;
$$;

grant execute on function public.friends_presence() to authenticated;
