-- ============================================================================
-- 0014  Addresses and early resolution
-- ============================================================================
--
-- Two additions, unrelated to each other except that both extend the same
-- notify-new-pin Edge Function rather than introducing a second one:
--
--   1. address column on posts, filled in asynchronously by reverse
--      geocoding after a post is created. Detail-only (not on the
--      lightweight viewport pin), the same tier body/author/media already
--      live at.
--
--   2. Early resolution. A non-author can flag a post as resolved or out of
--      date; this notifies the post's AUTHOR, who alone decides whether to
--      remove it early. The flag is never itself a removal — a stranger
--      unilaterally killing someone else's post is exactly the abuse this
--      two-step shape avoids. Removal reuses the existing expiry mechanism
--      (expires_at moved to now()) rather than a new post_status value, so
--      every read path that already excludes expired posts handles an
--      early-resolved one identically, for free.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- address
-- ----------------------------------------------------------------------------
alter table public.posts add column address text;

comment on column public.posts.address is
  'Reverse-geocoded from the post''s (possibly precision-fuzzed) location by '
  'the notify-new-pin Edge Function shortly after creation. Null until that '
  'completes, and permanently null if the geocoding request ever fails — '
  'this column is populated best-effort, not guaranteed.';


-- ----------------------------------------------------------------------------
-- post_detail — now also returns address
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
    'zone',    (select z.name from public.zones z where z.id = p.zone_id)
  )
  from public.posts p
  join public.profiles a on a.id = p.author_id
  where p.id = p_post_id
    and soso.can_see_post(auth.uid(), p.author_id, p.audience, p.id);
$$;


-- ----------------------------------------------------------------------------
-- post_coordinates — service-role only, for the Edge Function's geocoding step
-- ----------------------------------------------------------------------------
-- Deliberately NOT granted to anon/authenticated. soso.pin() already exposes
-- a post's location to ordinary clients, snapped to whatever precision the
-- category calls for; this returns exactly what is stored, which is that
-- same already-fuzzed value, not the original device location. The
-- restriction isn't about protecting a MORE precise value than clients
-- already get — it's that a plain SQL wrapper like this has no reason to be
-- reachable by anything other than the one server-side caller that needs it.
-- ----------------------------------------------------------------------------
create or replace function public.post_coordinates(p_post_id uuid)
  returns table (lng double precision, lat double precision)
  language sql
  stable
  security definer
  set search_path = public, extensions, pg_temp
as $$
  select st_x(geom::geometry), st_y(geom::geometry)
  from public.posts
  where id = p_post_id;
$$;

revoke all on function public.post_coordinates(uuid) from public, anon, authenticated;
grant execute on function public.post_coordinates(uuid) to service_role;


-- ----------------------------------------------------------------------------
-- resolution_flags
-- ----------------------------------------------------------------------------
create table public.resolution_flags (
  id          uuid primary key default extensions.gen_random_uuid(),
  post_id     uuid not null references public.posts (id) on delete cascade,
  flagged_by  uuid not null references public.profiles (id) on delete cascade,
  reason      text not null check (reason in ('resolved', 'out_of_date')),
  created_at  timestamptz not null default now(),

  -- One flag per person per post. A second tap from the same person isn't a
  -- stronger signal, and flag_post_resolved below treats a repeat as a
  -- silent no-op rather than an error — there's no reason a double-tap
  -- should surface a failure to the person doing the flagging.
  unique (post_id, flagged_by)
);

create index resolution_flags_post_idx on public.resolution_flags (post_id);

alter table public.resolution_flags enable row level security;

-- Nobody, including the post's own author, can see WHO flagged their post —
-- only that it happened, via the notification itself. Matches
-- moderation_reports' existing privacy stance for the same reason: knowing
-- exactly who flagged something invites retaliation in a way "someone did"
-- does not.
create policy resolution_flags_read_own on public.resolution_flags
  for select to authenticated
  using (flagged_by = auth.uid());

revoke all on public.resolution_flags from anon, authenticated;
grant select on public.resolution_flags to authenticated;


-- ----------------------------------------------------------------------------
-- flag_post_resolved
-- ----------------------------------------------------------------------------
create or replace function public.flag_post_resolved(
  p_post_id uuid,
  p_reason  text
)
  returns void
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_uid    uuid := auth.uid();
  v_author uuid;
begin
  if v_uid is null then
    perform soso.fail('soso/unauthenticated');
  end if;
  if p_reason not in ('resolved', 'out_of_date') then
    perform soso.fail('soso/invalid_reason');
  end if;

  select author_id into v_author
  from public.posts
  where id = p_post_id and status = 'live' and expires_at > now();
  if not found then
    perform soso.fail('soso/post_not_found');
  end if;

  if v_author = v_uid then
    -- The author already has the authority to decide this outright; routing
    -- them through a notify-then-confirm loop with themselves would be a
    -- worse experience than just telling them which call actually does
    -- what they want.
    perform soso.fail('soso/use_resolve_post_instead');
  end if;

  insert into public.resolution_flags (post_id, flagged_by, reason)
  values (p_post_id, v_uid, p_reason)
  on conflict (post_id, flagged_by) do nothing;
end;
$$;

grant execute on function public.flag_post_resolved(uuid, text) to authenticated;


-- ----------------------------------------------------------------------------
-- resolve_post — author-only, immediate early expiry
-- ----------------------------------------------------------------------------
-- Sets expires_at to now() rather than introducing a new post_status value.
-- Every read path (feed_delta, cell_counts, post_detail) already excludes a
-- post the instant expires_at passes; reusing that means an early-resolved
-- post disappears through the exact same mechanism a naturally-expired one
-- does, with no new case for any client or query to special-case.
-- ----------------------------------------------------------------------------
create or replace function public.resolve_post(p_post_id uuid)
  returns void
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_uid  uuid := auth.uid();
  v_rows integer;
begin
  if v_uid is null then
    perform soso.fail('soso/unauthenticated');
  end if;

  update public.posts
  set expires_at = now()
  where id = p_post_id
    and author_id = v_uid
    and status = 'live'
    and expires_at > now();

  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    perform soso.fail('soso/not_yours_or_already_gone');
  end if;
end;
$$;

grant execute on function public.resolve_post(uuid) to authenticated;
