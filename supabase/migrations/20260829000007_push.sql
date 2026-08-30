-- ============================================================================
-- 0007  Push notifications
-- ============================================================================
--
-- THE DESIGN
-- ----------
-- Two tables, reusing what already existed rather than inventing a parallel
-- concept:
--
--   cell_subscriptions   already existed (migration 0003), unused until now.
--                        "which areas does this user want to hear about."
--   push_endpoints       new. "which browsers/devices can we actually reach
--                        them on." One row per subscribed browser — a user
--                        with a phone and a laptop has two.
--
-- A new post fans out by joining them: find everyone subscribed to the post's
-- cell (and category, if they narrowed it), then find their endpoints, then
-- push to each. Splitting "area I care about" from "device to reach me on"
-- means a user who opens the app on a second device doesn't need to
-- re-declare which areas matter to them.
--
-- WHY THE ACTUAL SENDING HAPPENS OUTSIDE THIS DATABASE
-- -----------------------------------------------------
-- Sending a Web Push message requires signing the request with a VAPID
-- *private* key, and a private key cannot live anywhere a client — or a
-- migration file committed to git — can read it. So this migration only goes
-- as far as firing an async HTTP call (via pg_net) to a Supabase Edge
-- Function on every new live post; the Edge Function (supabase/functions/
-- notify-new-pin/) holds the private key as a server secret and does the
-- actual sending. See that function's own comments for the rest of the story,
-- and the project README for the manual setup this requires — none of it is
-- automatic from just running these migrations.
-- ============================================================================

create schema if not exists net;
create extension if not exists pg_net with schema net;
grant usage on schema net to postgres;

-- ----------------------------------------------------------------------------
-- push_endpoints
-- ----------------------------------------------------------------------------
create table public.push_endpoints (
  id          uuid primary key default extensions.gen_random_uuid(),
  user_id     uuid not null references public.profiles (id) on delete cascade,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  created_at  timestamptz not null default now()
);

create index push_endpoints_user_idx on public.push_endpoints (user_id);

alter table public.push_endpoints enable row level security;

-- Writes only ever go through subscribe_to_push / unsubscribe_from_push
-- below (SECURITY DEFINER, bypassing RLS) — the same "no direct writes"
-- pattern as posts. Read access exists only so a client can check whether
-- its own endpoint is already registered.
create policy push_endpoints_read_own on public.push_endpoints
  for select to authenticated
  using (user_id = auth.uid());

revoke all on public.push_endpoints from anon, authenticated;
grant select on public.push_endpoints to authenticated;


-- ----------------------------------------------------------------------------
-- subscribe_to_push
-- ----------------------------------------------------------------------------
-- Registers (or re-registers, on conflict) one browser subscription, and
-- marks the given cells as areas that subscription's owner wants to hear
-- about. Both happen together because there is no reason a client would ever
-- call one without the other — a push endpoint with no watched cells is
-- inert, and a watched cell with no endpoint has nowhere to deliver to.
-- ----------------------------------------------------------------------------
create or replace function public.subscribe_to_push(
  p_endpoint text,
  p_p256dh   text,
  p_auth     text,
  p_cell_ids integer[],
  p_label    text default 'Nearby'
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
  if p_cell_ids is null or cardinality(p_cell_ids) = 0 then
    perform soso.fail('soso/no_cells');
  end if;
  if cardinality(p_cell_ids) > 16 then
    -- A push "area" is meant to be a neighbourhood, not a prefecture — this
    -- caps it well above what the client actually sends (a 3x3 block around
    -- one location) as a sanity limit, not a real product constraint.
    perform soso.fail('soso/too_many_cells');
  end if;

  insert into public.push_endpoints (user_id, endpoint, p256dh, auth)
  values (v_uid, p_endpoint, p_p256dh, p_auth)
  on conflict (endpoint) do update
    set user_id = excluded.user_id,
        p256dh  = excluded.p256dh,
        auth    = excluded.auth;

  foreach v_cell in array p_cell_ids loop
    insert into public.cell_subscriptions (user_id, cell_id, label)
    values (v_uid, v_cell, p_label)
    on conflict (user_id, cell_id) do update set label = excluded.label;
  end loop;
end;
$$;


-- ----------------------------------------------------------------------------
-- unsubscribe_from_push
-- ----------------------------------------------------------------------------
-- Removes the endpoint only. Deliberately leaves cell_subscriptions alone: a
-- user who revokes notification permission on one browser but keeps another
-- subscribed shouldn't lose their watched areas along with it. An endpoint
-- with no subscriber cares about is simply inert, not a rare edge case worth
-- special-casing.
-- ----------------------------------------------------------------------------
create or replace function public.unsubscribe_from_push(p_endpoint text)
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
  where endpoint = p_endpoint and user_id = auth.uid();
end;
$$;

grant execute on function public.subscribe_to_push(text, text, text, integer[], text)
  to authenticated;
grant execute on function public.unsubscribe_from_push(text) to authenticated;


-- ----------------------------------------------------------------------------
-- The trigger
-- ----------------------------------------------------------------------------
-- Fires once per new live post. Does the absolute minimum in the database —
-- fire an async HTTP call and get out of the way — because pg_net requests
-- are not started until the transaction commits, and because a failure here
-- must never be allowed to fail the INSERT that triggered it. That's what the
-- exception handler is for: a missing secret (not configured yet), a Vault
-- that isn't enabled, or any other failure all fall through to "do nothing,"
-- not "block someone from posting."
-- ----------------------------------------------------------------------------
create or replace function soso.notify_new_post()
  returns trigger
  language plpgsql
  security definer
  set search_path = public, extensions, net, vault, pg_temp
as $$
declare
  v_url    text;
  v_secret text;
begin
  select decrypted_secret into v_url    from vault.decrypted_secrets where name = 'push_function_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'push_trigger_secret';

  if v_url is null or v_url = '' then
    -- Not configured yet. Push is an optional feature layered on top of
    -- everything else in this schema; the app works completely without it.
    return new;
  end if;

  perform net.http_post(
    url     := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', coalesce(v_secret, '')),
    body    := jsonb_build_object(
                 'post_id',      new.id,
                 'cell_id',      new.cell_id,
                 'category_key', new.category_key,
                 'author_id',    new.author_id
               )
  );

  return new;
exception when others then
  return new;
end;
$$;

create trigger posts_notify_new
  after insert on public.posts
  for each row
  when (new.status = 'live')
  execute function soso.notify_new_post();
