-- ============================================================================
-- 0007  Standards-based Web Push subscriptions
-- ============================================================================
--
-- A subscription belongs to one anonymous/authenticated Soso account on one
-- browser installation. Its endpoint and encryption keys are opaque browser
-- credentials, not user profile data; they are never selectable by clients.
-- The notify-new-pin Edge Function uses the service role to read them.
--
-- This migration intentionally does NOT create the delivery trigger. Hosted
-- Supabase Database Webhooks are configured after the Edge Function is
-- deployed, because the function URL and webhook secret belong to a project,
-- not source control. See the README's "Enable push notifications" section.
-- ============================================================================

create table public.web_push_subscriptions (
  id          uuid primary key default extensions.gen_random_uuid(),
  user_id     uuid not null references public.profiles (id) on delete cascade,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint web_push_endpoint_https check (endpoint ~ '^https://'),
  constraint web_push_key_sizes check (length(p256dh) between 40 and 400 and length(auth) between 10 and 200)
);

create index web_push_subscriptions_user_idx on public.web_push_subscriptions (user_id);

alter table public.web_push_subscriptions enable row level security;
revoke all on public.web_push_subscriptions from anon, authenticated;

-- Browser push endpoints must be trusted vendor endpoints. This avoids turning
-- a forged subscription into a server-side request to an arbitrary host.
create or replace function soso.is_browser_push_endpoint(p_endpoint text)
  returns boolean
  language sql
  immutable
as $$
  select p_endpoint ~ '^https://(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|web\.push\.apple\.com)/';
$$;

create or replace function public.upsert_web_push_subscription(
  p_endpoint text,
  p_p256dh   text,
  p_auth     text
)
  returns void
  language plpgsql
  volatile
  security definer
  set search_path = public, soso, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    perform soso.fail('soso/unauthenticated');
  end if;
  if not soso.is_browser_push_endpoint(p_endpoint) then
    perform soso.fail('soso/invalid_push_endpoint');
  end if;
  if length(p_p256dh) not between 40 and 400 or length(p_auth) not between 10 and 200 then
    perform soso.fail('soso/invalid_push_subscription');
  end if;

  insert into public.web_push_subscriptions (user_id, endpoint, p256dh, auth)
  values (v_uid, p_endpoint, p_p256dh, p_auth)
  on conflict (endpoint) do update
    set user_id = excluded.user_id,
        p256dh = excluded.p256dh,
        auth = excluded.auth,
        updated_at = now();
end;
$$;

create or replace function public.remove_web_push_subscription(p_endpoint text)
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
  delete from public.web_push_subscriptions
  where user_id = v_uid and endpoint = p_endpoint;
end;
$$;

grant execute on function public.upsert_web_push_subscription(text, text, text) to authenticated;
grant execute on function public.remove_web_push_subscription(text) to authenticated;
