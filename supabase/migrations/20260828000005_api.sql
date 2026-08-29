-- ============================================================================
-- 0005  Public API
-- ============================================================================
--
-- This file IS the API contract. Five functions:
--
--   feed_delta(cells, since, categories, limit)  read the map
--   cell_counts(cells, categories)               read the map, zoomed out
--   create_post(...)                             write a post
--   vote_post(post, vote)                        corroborate or dispute
--   report_post(post, reason, detail)            moderation report
--
-- Errors are raised with a stable machine-readable code as the message, so the
-- client can branch on it. Codes are mirrored in src/domain/errors.ts.
-- ============================================================================

create or replace function soso.fail(code text, hint text default null)
  returns void
  language plpgsql
as $$
begin
  raise exception '%', code using errcode = 'P0001', hint = hint;
end;
$$;


-- ----------------------------------------------------------------------------
-- Wire format for a map pin
-- ----------------------------------------------------------------------------
-- Keys are one character on purpose. A pin is ~90 bytes like this against ~250
-- with descriptive keys, and the viewport response is the single hottest thing
-- this app sends. The mapping is defined once here and once in
-- src/domain/pins.ts, and nowhere else in the codebase deals with short keys.
--
--   i  id            g  [lng, lat]     x  expires_at (epoch seconds)
--   c  category      s  subtype        t  created_at (epoch seconds)
--   n  net corroboration                m  has media
--
-- `t` and `x` together give the client the post's whole lifetime, which is what
-- the map's freshness rendering runs on. Twelve extra bytes to avoid a detail
-- fetch per pin is a good trade.
--
-- Body text, author and media are deliberately absent: they are fetched on tap.
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
    'm', exists (select 1 from public.post_media m where m.post_id = p.id)
  );
$$;


-- ----------------------------------------------------------------------------
-- feed_delta  -- the hot path
-- ----------------------------------------------------------------------------
-- Called on map idle and on a slow heartbeat. With `p_since` set it returns
-- only what changed, which in a quiet neighbourhood is an empty array of about
-- 150 bytes rather than a 40 KB full refetch.
--
-- Returns:
--   { cursor, added: [pin], removed: [id], truncated: bool }
--
-- `removed` is what makes incremental fetching correct. A post that was hidden,
-- removed by a moderator, or moved out of a category you filter on must be
-- dropped from the client's map, and a client holding only `added` could never
-- learn that. Expiry is NOT in `removed`: the client already holds `expires_at`
-- for every pin and drops them locally, which costs zero requests.
--
-- SECURITY DEFINER because tombstones for other users' removed posts are not
-- selectable under RLS. Only the id is exposed for a non-live post, which is
-- exactly what a client that already has the pin needs and nothing more.
--
-- CURSOR SEMANTICS: `updated_at` is assigned before commit, so a transaction
-- can commit after a later-timestamped one. We lap the cursor back 10 seconds
-- to cover the window, which means clients occasionally see a row twice. They
-- key by id, so a repeat is a no-op. This is much simpler than a commit-order
-- sequence and the failure mode is a duplicate rather than a miss.
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
-- cell_counts  -- the zoomed-out path
-- ----------------------------------------------------------------------------
-- Above the pin zoom threshold the client asks for counts instead of rows.
-- Fifty cells is about 1.5 KB against 40 KB of pins, and it removes the
-- "render 3000 markers on a mid-range Android" problem entirely.
-- ----------------------------------------------------------------------------
create or replace function public.cell_counts(
  p_cells      integer[],
  p_categories text[] default null
)
  returns table (cell_id integer, n integer)
  language sql
  stable
  security invoker
  set search_path = public, pg_temp
as $$
  select p.cell_id, count(*)::integer
  from public.posts p
  join public.post_categories c on c.key = p.category_key and c.is_enabled
  where p.cell_id = any (p_cells)
    and p.status = 'live'
    and p.expires_at > now()
    and (p_categories is null or p.category_key = any (p_categories))
  group by p.cell_id;
$$;


-- ----------------------------------------------------------------------------
-- create_post
-- ----------------------------------------------------------------------------
-- All of the rules that matter run here, in one place, in a readable order.
--
-- `p_device_*` is where the poster's device says it is, as distinct from
-- `p_lng/p_lat` which is what they are posting about. For proximity-gated
-- categories the two must agree. This is a weak check on the web (GPS is
-- trivially spoofed in a browser) and a much stronger one in a native build
-- backed by App Attest / Play Integrity. The server-side shape is the same
-- either way, which is why it goes in now rather than later.
-- ----------------------------------------------------------------------------
create or replace function public.create_post(
  p_category     text,
  p_lng          double precision,
  p_lat          double precision,
  p_subtype      text             default null,
  p_body         text             default null,
  p_device_lng   double precision default null,
  p_device_lat   double precision default null,
  p_ttl_minutes  integer          default null
)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = public, extensions, pg_temp
as $$
declare
  v_uid      uuid := auth.uid();
  v_profile  public.profiles;
  v_cat      public.post_categories;
  v_target   extensions.geography;
  v_device   extensions.geography;
  v_ttl      interval;
  v_post     public.posts;
  v_recent   integer;
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

  -- Fuzz before storing. The precise coordinate is never written to disk, so
  -- it cannot leak later through a dump, a bug, or a subpoena.
  v_target := soso.snap(v_target, v_cat.location_precision_m);

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
  insert into public.posts (author_id, category_key, subtype_key, body, geom, expires_at)
  values (
    v_uid,
    p_category,
    p_subtype,
    nullif(trim(coalesce(p_body, '')), ''),
    v_target,
    now() + v_ttl
  )
  returning * into v_post;

  return soso.pin(v_post);
end;
$$;


-- ----------------------------------------------------------------------------
-- Vote counts and auto-hide
-- ----------------------------------------------------------------------------
-- Counts are maintained by trigger rather than computed on read, because the
-- viewport query must not aggregate. The same trigger applies the auto-hide
-- rule: enough disputes and the pin comes off the map immediately, pending
-- human review. Getting this wrong in the safe direction (hiding a true report)
-- is much cheaper than the alternative.
-- ----------------------------------------------------------------------------
create or replace function soso.dispute_threshold()
  returns integer language sql immutable as $$ select 3 $$;

create or replace function soso.tg_votes_recount()
  returns trigger
  language plpgsql
  set search_path = public, pg_temp
as $$
declare
  v_post_id uuid := coalesce(new.post_id, old.post_id);
  v_up      integer;
  v_down    integer;
begin
  select
    count(*) filter (where vote = 1)::integer,
    count(*) filter (where vote = -1)::integer
  into v_up, v_down
  from public.post_votes where post_id = v_post_id;

  update public.posts
  set confirm_count = v_up,
      dispute_count = v_down,
      status = case
        when status = 'live'
             and v_down >= soso.dispute_threshold()
             and v_down > v_up * 2
        then 'hidden'::public.post_status
        else status
      end
  where id = v_post_id;

  return null;
end;
$$;

create trigger post_votes_recount
  after insert or update or delete on public.post_votes
  for each row execute function soso.tg_votes_recount();


create or replace function public.vote_post(p_post_id uuid, p_vote smallint)
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
  if p_vote not in (-1, 1) then perform soso.fail('soso/invalid_vote'); end if;

  if not exists (
    select 1 from public.posts
    where id = p_post_id and status = 'live' and expires_at > now()
  ) then
    perform soso.fail('soso/post_unavailable');
  end if;

  if exists (select 1 from public.posts where id = p_post_id and author_id = v_uid) then
    perform soso.fail('soso/cannot_vote_own');
  end if;

  insert into public.post_votes (post_id, voter_id, vote)
  values (p_post_id, v_uid, p_vote)
  on conflict (post_id, voter_id) do update set vote = excluded.vote;
end;
$$;


create or replace function public.report_post(
  p_post_id uuid,
  p_reason  public.report_reason,
  p_detail  text default null
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

  insert into public.moderation_reports (post_id, reporter_id, reason, detail)
  values (p_post_id, v_uid, p_reason, nullif(trim(coalesce(p_detail, '')), ''))
  on conflict (post_id, reporter_id) do nothing;
end;
$$;


-- ----------------------------------------------------------------------------
-- Profile bootstrap
-- ----------------------------------------------------------------------------
create or replace function soso.tg_new_user()
  returns trigger
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
begin
  insert into public.profiles (id, handle, display_name)
  values (
    new.id,
    'u' || substr(replace(new.id::text, '-', ''), 1, 12),
    coalesce(new.raw_user_meta_data ->> 'display_name', 'Soso User')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function soso.tg_new_user();


-- ----------------------------------------------------------------------------
-- Function grants. Explicit, because the default is EXECUTE to PUBLIC.
-- ----------------------------------------------------------------------------
revoke execute on all functions in schema public from anon, authenticated;

grant execute on function public.feed_delta(integer[], timestamptz, text[], integer)
  to anon, authenticated;
grant execute on function public.cell_counts(integer[], text[])
  to anon, authenticated;
grant execute on function public.create_post(
  text, double precision, double precision, text, text,
  double precision, double precision, integer) to authenticated;
grant execute on function public.vote_post(uuid, smallint) to authenticated;
grant execute on function public.report_post(uuid, public.report_reason, text) to authenticated;


-- ----------------------------------------------------------------------------
-- post_detail  -- everything the pin deliberately left out
-- ----------------------------------------------------------------------------
-- Reading `posts` directly through PostgREST hands back PostGIS binary for the
-- geometry, so detail goes through a function like everything else. It also
-- keeps the author join in one place rather than in every client.
-- ----------------------------------------------------------------------------
create or replace function public.post_detail(p_post_id uuid)
  returns jsonb
  language sql
  stable
  security invoker
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
    'mine',    p.author_id = auth.uid()
  )
  from public.posts p
  join public.profiles a on a.id = p.author_id
  where p.id = p_post_id;
$$;

grant execute on function public.post_detail(uuid) to anon, authenticated;
