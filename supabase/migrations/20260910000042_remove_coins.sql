-- ----------------------------------------------------------------------------
-- 0042 — remove the coin system
-- ----------------------------------------------------------------------------
--
-- The coin economy (migration 0016, plus the debug grant in 0019) is being
-- withdrawn before it ever shipped. It existed to make posting cost
-- something: you earned coins by walking and spent 10 of them to drop a pin,
-- so a pin was meant to be evidence that someone had actually been out in the
-- world. In practice the earning half was never wired to any UI — nothing in
-- the app ever called `record_walk` — so the only thing the economy did was
-- silently deplete a starting balance of 500 until posting stopped working.
--
-- WHAT THIS REMOVES
--   * `profiles.coin_balance`, `coin_transactions`, `walk_contributions`
--   * `record_walk`, `my_coin_balance`, `debug_grant_coins`
--   * the balance check and the charge inside `create_post`
--   * `'coins'` from the `my_profile` / `update_profile` result objects
--
-- WHAT THIS DOES NOT REMOVE
-- Anti-abuse limits. `create_post` still enforces its hourly post cap, and
-- chat still rate-limits, because those exist to stop flooding rather than to
-- price a post. "Everyone can post without limits" means the coin gate is
-- gone, not that the spam controls are.
--
-- DESTRUCTIVE. `coin_transactions` and `walk_contributions` are dropped with
-- their contents, and `profiles.coin_balance` goes with them. There is no
-- back-out short of restoring a backup; the data has no meaning once the
-- economy it accounted for does not exist.
--
-- The functions below are restated in full rather than patched, which is the
-- convention in this directory: a migration you can read start to finish is
-- the definition, and there is no partial-DDL way to edit a function body.
-- ----------------------------------------------------------------------------


-- ----------------------------------------------------------------------------
-- create_post — without the coin balance check and the charge
-- ----------------------------------------------------------------------------
-- Byte-for-byte the 0023 definition minus three blocks: the `c_post_cost`
-- constant, the `insufficient_coins` guard, and the debit-plus-ledger-write
-- after the insert. Everything else — zone resolution, the hourly cap, the
-- audience and recipient handling — is unchanged.

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
  if v_cat.requires_location then
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
    v_zone := soso.zone_for_point(v_uid, v_target);
  else
    -- v_target stays null; v_zone stays its default-initialised (all-null)
    -- record, so v_zone.audience and v_zone.id below both read as null,
    -- exactly the "no zone lookup involved" behaviour a location-less post
    -- needs. No separate branch is needed further down for this reason.
    v_target := null;
  end if;

  ---------------------------------------------------------------- audience
  v_audience := coalesce(p_audience, v_zone.audience, 'public');

  if v_audience = 'custom' then
    if p_recipients is null or cardinality(p_recipients) = 0 then
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
-- my_profile / update_profile — without 'coins'
-- ----------------------------------------------------------------------------
-- These two must keep returning the same shape as each other: the gateway
-- decodes both with one decoder, so a key removed from one has to go from the
-- other in the same breath.

create or replace function public.my_profile()
  returns jsonb
  language sql
  stable
  security invoker
  set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id',      p.id,
    'handle',  p.handle,
    'name',    p.display_name,
    'bio',     p.bio,
    'avatar',  p.avatar_path
  )
  from public.profiles p
  where p.id = auth.uid();
$$;


create or replace function public.update_profile(
  p_display_name text,
  p_bio          text,
  p_avatar_path  text default null
)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_uid    uuid := auth.uid();
  v_name   text := trim(coalesce(p_display_name, ''));
  v_bio    text := trim(coalesce(p_bio, ''));
  -- An empty string is not a path; it is someone sending "" where they meant
  -- null. Collapsing the two here means every reader downstream has exactly
  -- one way to spell "no picture".
  v_avatar text := nullif(trim(coalesce(p_avatar_path, '')), '');
begin
  if v_uid is null then
    perform soso.fail('soso/unauthenticated');
  end if;

  if length(v_name) < 1 or length(v_name) > 40 then
    perform soso.fail('soso/invalid_display_name');
  end if;

  if length(v_bio) > 160 then
    perform soso.fail('soso/bio_too_long');
  end if;

  if v_avatar is not null and (
       length(v_avatar) > 200
       or v_avatar not like v_uid::text || '/%'
       or length(v_avatar) - length(replace(v_avatar, '/', '')) <> 1
       or position('..' in v_avatar) > 0
     ) then
    perform soso.fail('soso/invalid_avatar_path');
  end if;

  update public.profiles
     set display_name = v_name,
         bio = v_bio,
         avatar_path = v_avatar
   where id = v_uid;

  -- Same shape my_profile returns, so the gateway decodes both with one
  -- decoder and the caller can render the saved row without a second fetch.
  return (
    select jsonb_build_object(
      'id',     p.id,
      'handle', p.handle,
      'name',   p.display_name,
      'bio',    p.bio,
      'avatar', p.avatar_path
    )
    from public.profiles p
    where p.id = v_uid
  );
end;
$$;


-- ----------------------------------------------------------------------------
-- Drop the economy itself
-- ----------------------------------------------------------------------------
-- Order matters only in that the functions go before the tables they write
-- to, so nothing is left referring to something that has just vanished.

drop function if exists public.record_walk(integer, integer);
drop function if exists public.my_coin_balance();
drop function if exists public.debug_grant_coins();

drop table if exists public.coin_transactions;
drop table if exists public.walk_contributions;

-- The column carried an explicit `revoke update` from 0016 to keep clients
-- from writing their own balance; dropping the column takes that with it.
alter table public.profiles
  drop column if exists coin_balance;
