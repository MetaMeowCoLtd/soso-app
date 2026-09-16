-- ============================================================================
-- 0052  Native push tokens (iOS/Android)
-- ============================================================================
--
-- WHY THIS IS ADDITIVE, NOT A REWRITE OF 0007
-- --------------------------------------------------------------------------
-- `push_endpoints` (migration 0007) is shaped for Web Push: a subscription
-- `endpoint` URL plus two encryption keys (`p256dh`/`auth`), because that is
-- the only thing a browser's `PushManager.subscribe()` ever hands back. A
-- native app has no such concept — `expo-notifications` on a device hands
-- back a single opaque Expo push token instead, and Expo's own push service
-- (`https://exp.host/--/api/v2/push/send`) is what turns that into a real
-- APNs or FCM delivery. Rather than replace the Web Push shape with the
-- native one, this widens the same table to hold either, so a person with
-- both the PWA and the native app installed shows up as two rows the exact
-- same way "a phone and a laptop" already did — and the still-live web PWA
-- (apps/web) keeps working against the untouched `subscribe_to_push`/
-- `unsubscribe_from_push` RPCs from 0007 without any change on its side.
--
-- `platform` distinguishes the two shapes rather than inferring it from
-- which columns are null, so a future third shape (say, a desktop native
-- app) has an explicit value to add rather than one more nullable-column
-- inference to get right.
-- ============================================================================

alter table public.push_endpoints
  alter column endpoint drop not null,
  alter column p256dh drop not null,
  alter column auth drop not null;

alter table public.push_endpoints
  add column platform text not null default 'web',
  add column expo_push_token text;

alter table public.push_endpoints
  add constraint push_endpoints_platform_check
    check (platform in ('web', 'ios', 'android'));

alter table public.push_endpoints
  add constraint push_endpoints_shape_check
    check (
      (platform = 'web' and endpoint is not null and p256dh is not null and auth is not null)
      or
      (platform in ('ios', 'android') and expo_push_token is not null)
    );

-- A plain (non-partial) unique constraint, deliberately: Postgres never
-- treats two NULLs as duplicates under a standard unique constraint, so
-- every web-platform row (expo_push_token always null there) is already
-- exempt without needing a partial index — and a plain constraint is what
-- `ON CONFLICT (expo_push_token) DO UPDATE` below can infer from directly.
alter table public.push_endpoints
  add constraint push_endpoints_expo_token_key unique (expo_push_token);

comment on column public.push_endpoints.platform is
  'web (Web Push, migration 0007) | ios | android (Expo push token, migration 0052).';
comment on column public.push_endpoints.expo_push_token is
  'An Expo push token (ExponentPushToken[...]) — null for a web (platform=web) row.';


-- ----------------------------------------------------------------------------
-- subscribe_to_native_push
-- ----------------------------------------------------------------------------
-- The native counterpart of subscribe_to_push (0007) — same validation, same
-- "register the device and mark the watched cells in one call" shape, just
-- keyed on an Expo push token instead of a Web Push endpoint URL.
-- ----------------------------------------------------------------------------
create or replace function public.subscribe_to_native_push(
  p_expo_push_token text,
  p_platform        text,
  p_cell_ids        integer[],
  p_label           text default 'Nearby'
)
  returns void
  language plpgsql
  volatile
  security definer
  set search_path = public, extensions, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_cell integer;
begin
  if v_uid is null then
    perform soso.fail('soso/unauthenticated');
  end if;
  if p_expo_push_token is null or p_expo_push_token = '' then
    perform soso.fail('soso/no_token');
  end if;
  if p_platform not in ('ios', 'android') then
    perform soso.fail('soso/invalid_platform');
  end if;
  if p_cell_ids is null or cardinality(p_cell_ids) = 0 then
    perform soso.fail('soso/no_cells');
  end if;
  if cardinality(p_cell_ids) > 16 then
    perform soso.fail('soso/too_many_cells');
  end if;

  insert into public.push_endpoints (user_id, platform, expo_push_token)
  values (v_uid, p_platform, p_expo_push_token)
  on conflict (expo_push_token) do update
    set user_id  = excluded.user_id,
        platform = excluded.platform;

  foreach v_cell in array p_cell_ids loop
    insert into public.cell_subscriptions (user_id, cell_id, label)
    values (v_uid, v_cell, p_label)
    on conflict (user_id, cell_id) do update set label = excluded.label;
  end loop;
end;
$$;


-- ----------------------------------------------------------------------------
-- unsubscribe_from_native_push
-- ----------------------------------------------------------------------------
create or replace function public.unsubscribe_from_native_push(p_expo_push_token text)
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
  delete from public.push_endpoints
  where expo_push_token = p_expo_push_token and user_id = auth.uid();
end;
$$;

grant execute on function public.subscribe_to_native_push(text, text, integer[], text)
  to authenticated;
grant execute on function public.unsubscribe_from_native_push(text) to authenticated;
