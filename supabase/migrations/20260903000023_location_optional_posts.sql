-- ============================================================================
-- 0023  Location-optional posts ("update"), Stage 1 (backend only)
-- ============================================================================
--
-- See POST_FEED_PLAN.md for the full three-stage plan this implements the
-- first stage of. Central decision, restated here because it is why this
-- migration is small: extend posts and create_post via one new config flag
-- (post_categories.requires_location) rather than fork into a parallel
-- feed_posts table. Every existing category keeps requires_location = true,
-- so every existing pin's behaviour — validation, audience, expiry,
-- moderation, media, voting — is byte-for-byte unchanged. Nothing in this
-- migration touches feed_delta or cell_counts at all: a null cell_id simply
-- never matches a viewport's cell list, which is the entire mechanism that
-- keeps a location-less post off the map, for free.
--
-- Zero UI ships with this. Verify against psql / the SQL editor directly —
-- same approach the coins and drawing-boards schemas both used before any
-- React code touched them.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- posts.geom / posts.cell_id become optional
-- ----------------------------------------------------------------------------
alter table public.posts alter column geom    drop not null;
alter table public.posts alter column cell_id drop not null;

-- soso.cell_of(null) is never exercised today because nothing before this
-- migration could produce a null geom — this is not "cell_of already
-- handled it", this is the first caller that can pass one. Branching here,
-- rather than depending on cell_of's own null behaviour, keeps that
-- guarantee explicit at the one place it actually matters.
create or replace function soso.tg_posts_derive()
  returns trigger
  language plpgsql
as $$
begin
  new.cell_id := case when new.geom is null then null else soso.cell_of(new.geom) end;
  new.updated_at := now();
  return new;
end;
$$;


-- ----------------------------------------------------------------------------
-- post_categories.requires_location
-- ----------------------------------------------------------------------------
-- Defaults true so every existing row (and every existing INSERT anywhere
-- that doesn't yet know this column exists) keeps requiring a location,
-- unchanged. Only the one new category below sets it false.
alter table public.post_categories
  add column requires_location boolean not null default true;

comment on column public.post_categories.requires_location is
  'False for exactly one category so far ("update") -- create_post skips lng/lat validation, the proximity check, and zone-based audience inheritance entirely when false. See create_post below.';

-- Mirrors 20260903000022_insert_board_category.sql's own precedent: seed.sql
-- is only exercised on a fresh `db reset`, so a live/already-migrated
-- database needs the row inserted here too. The two are kept in sync by
-- hand, matching every other hand-mirrored seed constant in this project.
insert into public.post_categories (
  key, label_ja, label_en,
  default_ttl, max_ttl,
  location_precision_m, requires_proximity, proximity_radius_m,
  allows_body, body_max_length, allows_media,
  min_reputation, hourly_post_limit, is_enabled, sort_order,
  requires_location
) values
('update', '近況アップデート', 'Update',
 interval '180 days', interval '180 days',
 0, false, 500,
 true, 280, true,
 0, 20, true, 100,
 false)
on conflict (key) do nothing;


-- ----------------------------------------------------------------------------
-- soso.pin — location is now optional in the wire format too
-- ----------------------------------------------------------------------------
-- 'g' becomes a plain null rather than [null, null] for a location-less
-- post. This is a wire-format change every consumer of Pin/WirePin needs to
-- treat 'g' as nullable for — see decodePin in packages/core, updated
-- alongside this migration in the same patch.
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
    'g', case when p.geom is null then null
              else jsonb_build_array(
                     round(st_x(p.geom::geometry)::numeric, 6),
                     round(st_y(p.geom::geometry)::numeric, 6)
                   )
         end,
    't', extract(epoch from p.created_at)::bigint,
    'x', extract(epoch from p.expires_at)::bigint,
    'n', p.confirm_count - p.dispute_count,
    'm', exists (select 1 from public.post_media m where m.post_id = p.id),
    'a', case when p.audience = 'public' then null else p.audience::text end
  );
$$;


-- ----------------------------------------------------------------------------
-- post_replies
-- ----------------------------------------------------------------------------
-- Flat, one level deep -- Threads-style top-level replies, not a nested
-- comment tree. That is a deliberate v1 scope cut, not an oversight: a
-- reply-to-a-reply model needs its own parent_reply_id and a different
-- (recursive) fetch shape, and nothing about this feature needs it yet.
--
-- Generic over any post, not scoped to the "update" category specifically —
-- replying under a construction pin is exactly as valid as replying under
-- an update, and gating this to one category would be an arbitrary
-- restriction the schema has no real reason to enforce.
--
-- status mirrors posts.status's own tombstone convention (never hard-delete
-- -- see the comment above the posts table in migration 0003) rather than
-- following chat_messages' hard-DELETE precedent in 0015: a reply is a
-- reply to something specific and, unlike a chat message in a single
-- scrolling room, its absence would be a visible gap in a specific thread
-- someone might be looking at right now.
create table public.post_replies (
  id          uuid primary key default extensions.gen_random_uuid(),
  post_id     uuid not null references public.posts (id) on delete cascade,
  author_id   uuid not null references public.profiles (id) on delete cascade,
  body        text not null check (length(trim(body)) between 1 and 500),
  status      public.post_status not null default 'live',
  created_at  timestamptz not null default now()
);

create index post_replies_post_idx on public.post_replies (post_id, created_at asc);

comment on table public.post_replies is
  'Flat, one level deep. Generic over any post -- see this migration''s own header comment for why this is not scoped to one category.';

alter table public.posts add column reply_count integer not null default 0;

comment on column public.posts.reply_count is
  'Denormalised from post_replies, mirroring confirm_count/dispute_count''s own approach. Maintained directly inside create_post_reply/delete_post_reply rather than by trigger, matching those columns'' own precedent (see vote_post in migration 0005).';

alter table public.post_replies enable row level security;

-- Same shape as media_read (migration 0012): a reply is only as visible as
-- the post it replies to. There is no separate per-reply audience -- a
-- reply to a friends-only post is exactly as friends-only as the post
-- itself, with no mechanism (yet) to make a single reply more restrictive
-- than its parent.
create policy post_replies_read on public.post_replies
  for select to anon, authenticated
  using (
    status = 'live'
    and exists (
      select 1 from public.posts p
      where p.id = post_replies.post_id
        and soso.can_see_post(auth.uid(), p.author_id, p.audience, p.id)
    )
  );

revoke all on public.post_replies from anon, authenticated;
grant select on public.post_replies to anon, authenticated;

-- Writes only ever go through create_post_reply / delete_post_reply below,
-- exactly like posts itself -- no direct INSERT/UPDATE/DELETE grant.


-- ----------------------------------------------------------------------------
-- create_post — one new branch, same signature
-- ----------------------------------------------------------------------------
-- Restated in whole from migration 0016 (same signature -- PostgREST callers
-- are unaffected) with one addition: when the resolved category's
-- requires_location is false, skip lng/lat validation, the proximity-check
-- block, and zone_for_point entirely, and write geom = null. Every existing
-- category keeps requires_location = true, so that branch is completely
-- unchanged -- this is a pure addition, not a rewrite of the existing path.
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

  ---------------------------------------------------------------- charge
  update public.profiles
  set coin_balance = coin_balance - c_post_cost
  where id = v_uid;

  insert into public.coin_transactions (user_id, amount, reason, reference_id)
  values (v_uid, -c_post_cost, 'post_pin', v_post.id);

  return soso.pin(v_post);
end;
$$;


-- ----------------------------------------------------------------------------
-- post_detail — now also reports reply_count
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
    'address', p.address,
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
    'zone',    (select z.name from public.zones z where z.id = p.zone_id),
    'replies', p.reply_count
  )
  from public.posts p
  join public.profiles a on a.id = p.author_id
  where p.id = p_post_id
    and soso.can_see_post(auth.uid(), p.author_id, p.audience, p.id);
$$;


-- ----------------------------------------------------------------------------
-- list_feed_posts — the global, location-less feed
-- ----------------------------------------------------------------------------
-- Scoped to `cell_id is null` rather than to category_key = 'update'
-- specifically: absence of a cell is what actually makes a post
-- meaningless to show on the map, and scoping the feed by that same signal
-- means any future location-less category automatically appears here too,
-- with no code change. feed_delta is deliberately not reused for this --
-- it is fundamentally viewport/cell-driven, which has no meaning for a
-- post that was never given a cell in the first place.
--
-- Row shape is soso.pin() plus exactly the same additional fields
-- post_detail adds, for the same reason list_feed_posts and post_detail
-- are decoded through the same PostDetail type in packages/core: one
-- shape, one decoder, used by both a single-item fetch and a paginated
-- list of them.
create or replace function public.list_feed_posts(
  p_before timestamptz default null,
  p_limit  integer default 20
)
  returns jsonb
  language sql
  stable
  security definer
  set search_path = public, extensions, pg_temp
as $$
  select jsonb_build_object(
    'cursor', (select min(created_at) from page),
    'posts',  coalesce((select jsonb_agg(row_json order by created_at desc) from page), '[]'::jsonb)
  )
  from (
    select
      soso.pin(p.*) || jsonb_build_object(
        'body',    p.body,
        'created', p.created_at,
        'up',      p.confirm_count,
        'down',    p.dispute_count,
        'address', p.address,
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
        'zone',    null,
        'replies', p.reply_count
      ) as row_json,
      p.created_at
    from public.posts p
    join public.profiles a on a.id = p.author_id
    where p.cell_id is null
      and p.status = 'live'
      and p.expires_at > now()
      and (p_before is null or p.created_at < p_before)
      and soso.can_see_post(auth.uid(), p.author_id, p.audience, p.id)
    order by p.created_at desc
    limit least(greatest(coalesce(p_limit, 20), 1), 50)
  ) page;
$$;

grant execute on function public.list_feed_posts(timestamptz, integer) to anon, authenticated;


-- ----------------------------------------------------------------------------
-- create_post_reply
-- ----------------------------------------------------------------------------
create or replace function public.create_post_reply(
  p_post_id uuid,
  p_body    text
)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = public, extensions, pg_temp
as $$
declare
  v_uid    uuid := auth.uid();
  v_body   text := trim(coalesce(p_body, ''));
  v_post   public.posts;
  v_author public.profiles;
  v_row    public.post_replies;
begin
  if v_uid is null then
    perform soso.fail('soso/unauthenticated');
  end if;

  select * into v_post from public.posts where id = p_post_id;
  if not found
     or not soso.can_see_post(v_uid, v_post.author_id, v_post.audience, v_post.id) then
    perform soso.fail('soso/post_not_found');
  end if;
  if v_post.status <> 'live' or v_post.expires_at <= now() then
    perform soso.fail('soso/post_not_found');
  end if;

  if length(v_body) = 0 then
    perform soso.fail('soso/empty_message');
  end if;
  -- Fixed cap, not the owning post's own body_max_length: a reply is a
  -- short response by nature regardless of how long the post it is
  -- replying to was allowed to be. Matches chat_messages' own 500 char
  -- cap in migration 0015.
  if length(v_body) > 500 then
    perform soso.fail('soso/reply_too_long');
  end if;

  insert into public.post_replies (post_id, author_id, body)
  values (p_post_id, v_uid, v_body)
  returning * into v_row;

  update public.posts set reply_count = reply_count + 1 where id = p_post_id;

  select * into v_author from public.profiles where id = v_uid;

  return jsonb_build_object(
    'id', v_row.id,
    'post_id', v_row.post_id,
    'body', v_row.body,
    'created_at', v_row.created_at,
    'author_id', v_row.author_id,
    'author_handle', v_author.handle,
    'author_name', v_author.display_name,
    'mine', true
  );
end;
$$;

grant execute on function public.create_post_reply(uuid, text) to authenticated;


-- ----------------------------------------------------------------------------
-- delete_post_reply — author-only, soft delete
-- ----------------------------------------------------------------------------
-- Same "not yours or already gone" shape used elsewhere (soso/not_yours_or
-- _already_gone, already registered for an equivalent case) rather than a
-- reply-specific "not found" code: distinguishing "doesn't exist" from
-- "exists but isn't yours" in the error itself would tell a caller
-- something about a reply they have no business learning either way.
create or replace function public.delete_post_reply(p_reply_id uuid)
  returns void
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_uid   uuid := auth.uid();
  v_reply public.post_replies;
begin
  if v_uid is null then
    perform soso.fail('soso/unauthenticated');
  end if;

  select * into v_reply from public.post_replies
  where id = p_reply_id and author_id = v_uid and status = 'live';
  if not found then
    perform soso.fail('soso/not_yours_or_already_gone');
  end if;

  update public.post_replies set status = 'removed' where id = p_reply_id;
  update public.posts set reply_count = greatest(reply_count - 1, 0) where id = v_reply.post_id;
end;
$$;

grant execute on function public.delete_post_reply(uuid) to authenticated;


-- ----------------------------------------------------------------------------
-- get_post_replies
-- ----------------------------------------------------------------------------
create or replace function public.get_post_replies(
  p_post_id uuid,
  p_before  timestamptz default null,
  p_limit   integer default 50
)
  returns jsonb
  language plpgsql
  stable
  security definer
  set search_path = public, extensions, pg_temp
as $$
declare
  v_post public.posts;
begin
  select * into v_post from public.posts where id = p_post_id;
  if not found
     or not soso.can_see_post(auth.uid(), v_post.author_id, v_post.audience, v_post.id) then
    perform soso.fail('soso/post_not_found');
  end if;

  return coalesce(
    (
      select jsonb_agg(row_json order by created_at asc)
      from (
        select jsonb_build_object(
          'id', r.id,
          'post_id', r.post_id,
          'body', r.body,
          'created_at', r.created_at,
          'author_id', r.author_id,
          'author_handle', p.handle,
          'author_name', p.display_name,
          'mine', r.author_id = auth.uid()
        ) as row_json,
        r.created_at
        from public.post_replies r
        join public.profiles p on p.id = r.author_id
        where r.post_id = p_post_id
          and r.status = 'live'
          and (p_before is null or r.created_at < p_before)
        order by r.created_at desc
        limit least(greatest(coalesce(p_limit, 50), 1), 100)
      ) recent
    ),
    '[]'::jsonb
  );
end;
$$;

grant execute on function public.get_post_replies(uuid, timestamptz, integer) to anon, authenticated;
