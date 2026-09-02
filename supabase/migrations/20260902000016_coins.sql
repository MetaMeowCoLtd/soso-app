-- ============================================================================
-- 0016  Coin economy
-- ============================================================================
--
-- A small in-app currency: walking earns coins, posting a pin spends them.
-- The constants here (10 coins per km, 10 coins per pin) are mirrored by hand
-- in `packages/core/src/domain/coins.ts` — see the comment at the top of that
-- file. If either changes, change both.
--
-- Design notes:
--   * `profiles.coin_balance` is the fast, denormalised read path (one column
--     on a row every screen already fetches via `my_profile`). It is never
--     written directly by a client — see the `revoke update` below, which
--     mirrors how `reputation` is already protected.
--   * `coin_transactions` is the audit trail: every balance change, signed,
--     with a reason and a reference back to what caused it. The balance
--     column is a cache of this ledger's running sum, not a second source of
--     truth — `record_walk` and `create_post` update both in the same
--     transaction, so they can never drift.
--   * `walk_contributions` exists separately from the ledger so the
--     anti-abuse checks in `record_walk` (rate limiting, plausibility) have
--     raw distance/time to inspect, not just the coin amount it produced.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- Balance column
-- ----------------------------------------------------------------------------
-- 500 is the starting grant for every account — existing rows are backfilled
-- to it by this ADD COLUMN ... DEFAULT, and it becomes the default for every
-- row inserted afterwards too. Chosen to be generous enough that a new user
-- can post several pins (50 coins) before ever having to walk, so the coin
-- requirement doesn't block early usage while the habit of earning them
-- through walking is still forming.
alter table public.profiles
  add column coin_balance integer not null default 500 check (coin_balance >= 0);

-- Same protection as `reputation`: readable like any other profile field
-- (see `profiles_read`, migration 0004), writable only through the
-- security-definer functions below.
revoke update (coin_balance) on public.profiles
  from anon, authenticated;


-- ----------------------------------------------------------------------------
-- Ledger
-- ----------------------------------------------------------------------------
create table public.coin_transactions (
  id           uuid primary key default extensions.gen_random_uuid(),
  user_id      uuid not null references public.profiles (id) on delete cascade,
  -- Positive = earned, negative = spent. Never zero: a no-op transaction
  -- would just be noise in the audit trail.
  amount       integer not null check (amount <> 0),
  reason       text not null check (reason in ('walk', 'post_pin')),
  -- The walk_contributions.id or posts.id that produced this entry. Left
  -- nullable rather than a typed FK because it points at different tables
  -- depending on `reason`.
  reference_id uuid,
  created_at   timestamptz not null default now()
);

create index coin_transactions_user_idx on public.coin_transactions (user_id, created_at desc);

alter table public.coin_transactions enable row level security;

-- Your own coin history, nobody else's. There is no broader "leaderboard"
-- read here on purpose — see the comment on `reputation` in migration 0003
-- about not turning an anti-abuse/economy number into a public score.
create policy coin_transactions_read_own on public.coin_transactions
  for select to authenticated
  using (user_id = auth.uid());


-- ----------------------------------------------------------------------------
-- Walk submissions
-- ----------------------------------------------------------------------------
create table public.walk_contributions (
  id           uuid primary key default extensions.gen_random_uuid(),
  user_id      uuid not null references public.profiles (id) on delete cascade,
  distance_m   integer not null check (distance_m > 0),
  elapsed_s    integer not null check (elapsed_s > 0),
  coins_earned integer not null check (coins_earned >= 0),
  created_at   timestamptz not null default now()
);

create index walk_contributions_user_idx on public.walk_contributions (user_id, created_at desc);

alter table public.walk_contributions enable row level security;

create policy walk_contributions_read_own on public.walk_contributions
  for select to authenticated
  using (user_id = auth.uid());


-- ----------------------------------------------------------------------------
-- record_walk
-- ----------------------------------------------------------------------------
-- Credits coins for a client-reported (distance, elapsed time) pair.
--
-- The client is not trusted: this checks the claim is physically plausible
-- for walking (rejects anything faster than a brisk walk/jog sustained for
-- the whole submission — a bus or bike ride, say), rejects submissions too
-- short to be reliable over GPS noise, caps how much distance a single call
-- can claim, and caps how many coins one user can earn from walking per
-- hour. None of this can tell a real walk from a very good simulation of
-- one; it only raises the cost of gaming it above what casual cheating will
-- bother with.
-- ----------------------------------------------------------------------------
create or replace function public.record_walk(
  p_distance_m integer,
  p_elapsed_s  integer
)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = public, extensions, pg_temp
as $$
declare
  v_uid           uuid := auth.uid();
  v_profile       public.profiles;
  v_coins         integer;
  v_balance       integer;
  v_walk          public.walk_contributions;
  v_recent_coins  integer;
  -- Mirror of packages/core/src/domain/coins.ts — keep both in sync.
  c_coins_per_km       constant integer          := 10;
  c_max_speed_mps      constant double precision := 2.5;
  c_min_elapsed_s      constant integer          := 30;
  c_max_distance_m     constant integer          := 20000;
  c_max_coins_per_hour constant integer          := 150;
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

  ---------------------------------------------------------------- shape
  if p_distance_m is null or p_elapsed_s is null
     or p_distance_m <= 0 or p_elapsed_s <= 0
     or p_distance_m > c_max_distance_m then
    perform soso.fail('soso/invalid_walk_distance');
  end if;
  if p_elapsed_s < c_min_elapsed_s then
    perform soso.fail('soso/invalid_walk_distance');
  end if;

  ---------------------------------------------------------------- plausibility
  if p_distance_m::double precision / p_elapsed_s::double precision > c_max_speed_mps then
    perform soso.fail('soso/implausible_walk');
  end if;

  ---------------------------------------------------------------- rate limit
  select coalesce(sum(coins_earned), 0)::integer into v_recent_coins
  from public.walk_contributions
  where user_id = v_uid and created_at > now() - interval '1 hour';

  v_coins := floor(p_distance_m * c_coins_per_km / 1000.0)::integer;

  if v_recent_coins + v_coins > c_max_coins_per_hour then
    perform soso.fail('soso/walk_rate_limited');
  end if;

  ---------------------------------------------------------------- credit
  insert into public.walk_contributions (user_id, distance_m, elapsed_s, coins_earned)
  values (v_uid, p_distance_m, p_elapsed_s, v_coins)
  returning * into v_walk;

  update public.profiles
  set coin_balance = coin_balance + v_coins
  where id = v_uid
  returning coin_balance into v_balance;

  insert into public.coin_transactions (user_id, amount, reason, reference_id)
  values (v_uid, v_coins, 'walk', v_walk.id);

  return jsonb_build_object('coinsEarned', v_coins, 'balance', v_balance);
end;
$$;

grant execute on function public.record_walk(integer, integer) to authenticated;


-- ----------------------------------------------------------------------------
-- my_coin_balance
-- ----------------------------------------------------------------------------
-- A number, nothing else — for a badge that polls just the balance rather
-- than the whole profile. Mirrors the shape of `area_presence_count`.
-- ----------------------------------------------------------------------------
create or replace function public.my_coin_balance()
  returns integer
  language sql
  stable
  security invoker
  set search_path = public, pg_temp
as $$
  select p.coin_balance
  from public.profiles p
  where p.id = auth.uid();
$$;

grant execute on function public.my_coin_balance() to authenticated;


-- ----------------------------------------------------------------------------
-- my_profile  -- now also reports the caller's coin balance
-- ----------------------------------------------------------------------------
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
    'coins',   p.coin_balance
  )
  from public.profiles p
  where p.id = auth.uid();
$$;


-- ----------------------------------------------------------------------------
-- create_post  -- now costs coins
-- ----------------------------------------------------------------------------
-- Restated in whole from migration 0011 (same signature — PostgREST callers
-- are unaffected) with one addition: the balance check right after the
-- profile/ban check, so a user without enough coins finds out before any
-- other validation runs, and the debit plus ledger entry right after the
-- insert succeeds, inside the same transaction as the post itself. A pin
-- that got written but never charged for, or a charge with no pin behind
-- it, are both bugs this ordering exists to rule out.
-- ----------------------------------------------------------------------------
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
  -- Mirror of POST_PIN_COST in packages/core/src/domain/coins.ts.
  c_post_cost constant integer := 10;
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

  ---------------------------------------------------------------- coins
  if v_profile.coin_balance < c_post_cost then
    perform soso.fail('soso/insufficient_coins');
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
  v_zone := soso.zone_for_point(v_uid, v_target);
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

  ---------------------------------------------------------------- charge
  update public.profiles
  set coin_balance = coin_balance - c_post_cost
  where id = v_uid;

  insert into public.coin_transactions (user_id, amount, reason, reference_id)
  values (v_uid, -c_post_cost, 'post_pin', v_post.id);

  return soso.pin(v_post);
end;
$$;
