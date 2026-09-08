-- ============================================================================
-- 0031  Phone-number authentication
-- ============================================================================
--
-- Closes the gap the README has been flagging since the first migration:
-- "anonymous sign-in is a development convenience, not a production
-- authentication model... Phone verification is required before using the
-- Supabase-backed mode with untrusted users." This is that phone
-- verification.
--
-- WHAT ACTUALLY VERIFIES THE NUMBER, AND WHY IT ISN'T THIS FILE
-- ---------------------------------------------------------------------
-- Supabase's own phone provider does the part that must not be
-- hand-rolled: generating the code, storing only its hash, expiring it,
-- and burning it on first use. Reimplementing that here would mean
-- reimplementing it worse — this is the same reasoning that puts the DM
-- cipher composition on SubtleCrypto rather than on hand-written
-- primitives. Instagram does not hand-roll SMS verification either; it
-- buys a verification service.
--
-- What this file adds is the half the platform cannot know about: who is
-- allowed to ASK for a code, how often, and what a verified account is
-- then permitted to do.
--
-- THE ATTACK THIS IS MOSTLY DEFENDING AGAINST
-- ---------------------------------------------------------------------
-- Not code guessing — Supabase already bounds that. The expensive one is
-- SMS pumping (a.k.a. toll fraud): an attacker drives signup requests at
-- numbers on premium-rate ranges they control and take a revenue share of,
-- and the victim is whoever pays the SMS bill. It is the single most
-- common way a phone-signup flow turns into a five-figure invoice, it
-- costs the attacker nothing, and no amount of OTP hardening touches it,
-- because every one of those messages is a perfectly valid first send to a
-- number nobody has tried before.
--
-- So the throttle below is keyed three ways — per number, per device, and
-- per country — because any single key is trivially sidestepped: a pumping
-- attack uses thousands of distinct numbers (defeating per-number alone)
-- from one script (caught by per-device), and concentrates on a handful of
-- country codes (caught by per-country). CAPTCHA on the send endpoint is
-- the other half and is configured in the dashboard, not here.
--
-- WHAT IS DELIBERATELY NOT STORED
-- ---------------------------------------------------------------------
-- The phone number. Not in `profiles`, not in the throttle table, not
-- returned by any RPC in this file. `auth.users.phone` already holds it,
-- in a schema PostgREST does not expose, and one copy of a piece of PII is
-- strictly better than two. The throttle keys on a peppered HMAC instead
-- (see `soso.phone_key`), which supports "have we seen this number before"
-- without supporting "list the numbers we have seen" — the property that
-- matters if this table is ever dumped.
--
-- Contact-list upload / find-friends-by-number is NOT built and is not an
-- oversight. It is the feature that turned into Meta's most expensive
-- privacy settlements, it requires uploading other people's numbers who
-- never consented, and this app has a handle search that does the same job
-- without it.
--
-- UNVERIFIED — READ THIS FIRST
-- ---------------------------------------------------------------------
-- Nothing in the sandbox that wrote this can run `supabase db push`, and
-- no SMS provider is configured, so this SQL is reviewed but unexecuted
-- and no real code has ever been delivered through it. Same standing
-- caveat as every migration since 0025 and as `notify-new-pin`. The
-- dashboard settings in the README's setup section are not optional
-- garnish — with the OTP expiry left at its 3600s default, most of the
-- hardening below is decoration.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- soso.phone_key — the throttle's identifier for a number
-- ----------------------------------------------------------------------------
-- HMAC rather than a plain digest: an unkeyed hash of a phone number is
-- reversible in seconds, because the input space is tiny. Every possible
-- Japanese mobile number is about 10^8 candidates, which is a rounding
-- error to brute force. The pepper is what makes the table useless without
-- also stealing a separate secret.
--
-- Stored in Vault rather than inline here so the pepper is not sitting in
-- a version-controlled file. A missing pepper FAILS rather than falling
-- back to unkeyed hashing — a silent downgrade to a reversible digest is
-- exactly the kind of "still works, quietly worthless" failure this whole
-- file exists to avoid.
-- ----------------------------------------------------------------------------
create or replace function soso.phone_key(p_e164 text)
  returns text
  language plpgsql
  stable
  security definer
  set search_path = public, extensions, pg_temp
as $$
declare
  v_pepper text;
begin
  select decrypted_secret into v_pepper
  from vault.decrypted_secrets
  where name = 'phone_hash_pepper';

  if v_pepper is null or length(v_pepper) < 32 then
    perform soso.fail('soso/internal_error', 'phone_hash_pepper is missing from Vault.');
  end if;

  return encode(extensions.hmac(p_e164, v_pepper, 'sha256'), 'hex');
end;
$$;


-- ----------------------------------------------------------------------------
-- otp_requests — one row per code we asked a provider to send
-- ----------------------------------------------------------------------------
-- Written only by the edge function that fronts the send (service_role);
-- no browser ever inserts here, which is why there is no policy granting
-- that. RLS is still enabled with no permissive policy at all, so a leaked
-- anon key reads nothing: the default under RLS is deny, and leaving the
-- table without policies is the strongest possible statement of intent.
-- ----------------------------------------------------------------------------
create table public.otp_requests (
  id           bigserial primary key,
  -- HMAC of the E.164 number. Never the number.
  phone_key    text not null,
  -- Coarse client fingerprint from the edge function (hashed IP + device
  -- id). Coarse on purpose: enough to rate-limit a script, not enough to
  -- be a tracking identifier worth keeping.
  client_key   text not null,
  -- The country calling code, kept in the clear because it is not
  -- identifying on its own and because the per-country ceiling below has
  -- to be able to group by it.
  country_code text not null check (country_code ~ '^[1-9]\d{0,2}$'),
  requested_at timestamptz not null default now(),
  -- Set when a code from this request is successfully redeemed, so a
  -- completed verification does not keep counting against the sender.
  consumed_at  timestamptz
);

create index otp_requests_phone_idx   on public.otp_requests (phone_key, requested_at desc);
create index otp_requests_client_idx  on public.otp_requests (client_key, requested_at desc);
create index otp_requests_country_idx on public.otp_requests (country_code, requested_at desc);

alter table public.otp_requests enable row level security;
revoke all on public.otp_requests from anon, authenticated;


-- ----------------------------------------------------------------------------
-- soso.check_otp_throttle — may this number be sent a code right now?
-- ----------------------------------------------------------------------------
-- Called by the edge function BEFORE it asks the provider to send
-- anything, because a limit enforced after the message goes out has
-- already let the attacker win the only thing they wanted.
--
-- The client has its own copy of the cooldown curve (see
-- `resendCooldownSeconds` in packages/core) purely so it can render an
-- honest countdown. This is the one that decides.
-- ----------------------------------------------------------------------------
create or replace function soso.check_otp_throttle(
  p_phone_key    text,
  p_client_key   text,
  p_country_code text
)
  returns void
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_recent_for_number  integer;
  v_last_at            timestamptz;
  v_cooldown           interval;
  v_recent_for_client  integer;
  v_recent_for_country integer;
begin
  -- Per number: the doubling cooldown. A real person retrying once barely
  -- notices; a loop pays minutes by its tenth message.
  select count(*), max(requested_at)
    into v_recent_for_number, v_last_at
  from public.otp_requests
  where phone_key = p_phone_key
    and requested_at > now() - interval '24 hours'
    and consumed_at is null;

  if v_recent_for_number >= 5 then
    perform soso.fail('soso/otp_rate_limited', 'Too many codes requested for this number today.');
  end if;

  if v_last_at is not null then
    v_cooldown := least(
      make_interval(secs => 30 * 2 ^ greatest(v_recent_for_number - 1, 0)),
      interval '15 minutes'
    );
    if now() < v_last_at + v_cooldown then
      perform soso.fail('soso/otp_cooldown', 'A code was just sent to this number.');
    end if;
  end if;

  -- Per device/IP: catches the case the per-number limit cannot see at
  -- all, which is one script walking thousands of DIFFERENT numbers. This
  -- is the limit that actually stops a pumping run.
  select count(*) into v_recent_for_client
  from public.otp_requests
  where client_key = p_client_key
    and requested_at > now() - interval '1 hour';

  if v_recent_for_client >= 10 then
    perform soso.fail('soso/otp_rate_limited', 'Too many verification attempts from this device.');
  end if;

  -- Per country: a blunt circuit breaker. Pumping concentrates on the
  -- ranges the attacker earns from, so an unfamiliar country code
  -- suddenly accounting for hundreds of sends an hour is the signal, and
  -- a cap that trips is far cheaper than an invoice. Set high enough that
  -- ordinary organic growth in a new market does not trip it.
  select count(*) into v_recent_for_country
  from public.otp_requests
  where country_code = p_country_code
    and requested_at > now() - interval '1 hour';

  if v_recent_for_country >= 200 then
    perform soso.fail('soso/otp_rate_limited', 'Verification is temporarily unavailable for this region.');
  end if;
end;
$$;


create or replace function soso.record_otp_request(
  p_phone_key    text,
  p_client_key   text,
  p_country_code text
)
  returns void
  language sql
  volatile
  security definer
  set search_path = public, pg_temp
as $$
  insert into public.otp_requests (phone_key, client_key, country_code)
  values (p_phone_key, p_client_key, p_country_code);
$$;


-- ----------------------------------------------------------------------------
-- soso.is_verified — the predicate everything else hangs off
-- ----------------------------------------------------------------------------
-- Reads `auth.users.phone_confirmed_at`, which only Supabase's own verify
-- step ever writes. That is the point: verification state is not a column
-- this application can set, so no RPC of ours can be tricked into granting
-- it, and there is no "verified" flag to get out of sync with reality.
--
-- SECURITY DEFINER because the auth schema is not readable by
-- `authenticated`, and deliberately narrow: it answers one boolean about
-- one user and exposes no other column of that table.
-- ----------------------------------------------------------------------------
create or replace function soso.is_verified(p_uid uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = auth, pg_temp
as $$
  select exists (
    select 1 from auth.users
    where id = p_uid and phone_confirmed_at is not null
  );
$$;


-- ----------------------------------------------------------------------------
-- soso.require_verified — the guard clause for write paths
-- ----------------------------------------------------------------------------
-- Distinguishes "not signed in" from "signed in but unverified", because
-- they need different screens: one is a login prompt, the other is a
-- "verify your number to post" prompt, and collapsing them into a single
-- error would send half of those users to the wrong place.
-- ----------------------------------------------------------------------------
create or replace function soso.require_verified()
  returns uuid
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    perform soso.fail('soso/unauthenticated');
  end if;
  if not soso.is_verified(v_uid) then
    perform soso.fail('soso/verification_required');
  end if;
  return v_uid;
end;
$$;


-- ----------------------------------------------------------------------------
-- profiles.handle_set_at — has this account chosen its own name yet?
-- ----------------------------------------------------------------------------
-- The `on_auth_user_created` trigger (migration 0005) gives every new
-- account a generated `u<12hex>` handle so that a profile row always
-- exists and nothing downstream has to cope with a null one. That is still
-- the right default, but it means "has a handle" cannot answer "has this
-- person finished signing up". This column can.
--
-- Backfilled as set for every existing row: those accounts predate signup
-- entirely, and dropping them all back into an onboarding screen they have
-- no way to interpret would be a worse outcome than letting them keep the
-- generated handle they already have.
-- ----------------------------------------------------------------------------
alter table public.profiles
  add column if not exists handle_set_at timestamptz;

update public.profiles set handle_set_at = created_at where handle_set_at is null;


-- ----------------------------------------------------------------------------
-- Reserved handles
-- ----------------------------------------------------------------------------
-- A handle sits next to content as its author. `@support` or `@moderator`
-- in that position is a phishing primitive, not a username. Mirrors the
-- list in packages/core/src/domain/phone.ts, which exists for instant
-- feedback while typing; this is the copy that actually decides, because a
-- check that only runs in a browser does not run for anyone who skips the
-- browser.
-- ----------------------------------------------------------------------------
create table public.reserved_handles (
  handle text primary key check (handle ~ '^[a-z0-9_]{1,20}$')
);

insert into public.reserved_handles (handle) values
  ('soso'), ('admin'), ('administrator'), ('root'), ('system'),
  ('support'), ('help'), ('staff'), ('moderator'), ('mod'),
  ('official'), ('security'), ('about'), ('settings'), ('login'),
  ('signup'), ('me'), ('you'), ('null'), ('undefined'), ('anonymous')
on conflict (handle) do nothing;

alter table public.reserved_handles enable row level security;
revoke all on public.reserved_handles from anon, authenticated;


-- ----------------------------------------------------------------------------
-- complete_signup — claim a handle and a display name
-- ----------------------------------------------------------------------------
-- Runs after verification, never before: `require_verified` is the first
-- statement, so an unverified caller cannot reserve a name.
--
-- Handle changes are allowed exactly once through this function — it is
-- the "finish signing up" step, not a rename feature. A rename that
-- silently frees the old handle for anyone to take is an impersonation
-- vector (take the handle someone just left, inherit the mentions), and
-- getting that right needs a reservation period this app has no reason to
-- build yet.
-- ----------------------------------------------------------------------------
create or replace function public.complete_signup(
  p_handle       text,
  p_display_name text
)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_uid    uuid := soso.require_verified();
  v_handle text := lower(trim(coalesce(p_handle, '')));
  v_name   text := trim(coalesce(p_display_name, ''));
  v_already timestamptz;
begin
  select handle_set_at into v_already from public.profiles where id = v_uid;
  if v_already is not null then
    perform soso.fail('soso/handle_already_set');
  end if;

  if v_handle !~ '^[a-z0-9_]{3,20}$' then
    perform soso.fail('soso/invalid_handle');
  end if;

  if exists (select 1 from public.reserved_handles where handle = v_handle) then
    perform soso.fail('soso/handle_reserved');
  end if;

  if length(v_name) < 1 or length(v_name) > 40 then
    perform soso.fail('soso/invalid_display_name');
  end if;

  -- The unique index on profiles.handle is what actually prevents two
  -- people claiming one name; this is only for a clean error message.
  -- Catching the violation below is what closes the race between the two.
  begin
    update public.profiles
       set handle = v_handle,
           display_name = v_name,
           handle_set_at = now()
     where id = v_uid;
  exception when unique_violation then
    perform soso.fail('soso/handle_taken');
  end;

  return jsonb_build_object('id', v_uid, 'handle', v_handle, 'name', v_name);
end;
$$;


-- ----------------------------------------------------------------------------
-- handle_available — for the "that one's taken" hint while typing
-- ----------------------------------------------------------------------------
-- This is an enumeration oracle by its nature: it answers "does this
-- account exist" by design, which is the exact question §enumeration
-- elsewhere in this schema works to refuse. It is offered anyway because
-- the alternative — letting someone fill in a signup form and rejecting it
-- on submit — is materially worse UX, and because handles are already
-- public: they are printed next to every post their owner writes, and
-- `follow_by_handle` has been resolving them since migration 0009.
--
-- So the exposure here is not new information, only faster access to it,
-- and it is bounded to verified callers so it costs an SMS to reach.
-- ----------------------------------------------------------------------------
create or replace function public.handle_available(p_handle text)
  returns boolean
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_handle text := lower(trim(coalesce(p_handle, '')));
begin
  perform soso.require_verified();

  if v_handle !~ '^[a-z0-9_]{3,20}$' then
    return false;
  end if;
  if exists (select 1 from public.reserved_handles where handle = v_handle) then
    return false;
  end if;
  return not exists (select 1 from public.profiles where handle = v_handle);
end;
$$;


-- ----------------------------------------------------------------------------
-- my_account — what the client needs to decide which screen to show
-- ----------------------------------------------------------------------------
-- Returns the phone MASKED, never whole. The client only ever needs to
-- show someone which of their own numbers an account is attached to, and
-- "+81 •••• 78" answers that completely. A screen, a screenshot, and a
-- support ticket are all places the full number would otherwise end up for
-- no benefit.
-- ----------------------------------------------------------------------------
create or replace function public.my_account()
  returns jsonb
  language plpgsql
  stable
  security definer
  set search_path = public, auth, pg_temp
as $$
declare
  v_uid   uuid := auth.uid();
  v_phone text;
  v_confirmed timestamptz;
  v_profile public.profiles;
begin
  if v_uid is null then
    return null;
  end if;

  select phone, phone_confirmed_at into v_phone, v_confirmed
  from auth.users where id = v_uid;

  select * into v_profile from public.profiles where id = v_uid;

  return jsonb_build_object(
    'id',            v_uid,
    'verified',      v_confirmed is not null,
    -- The client uses this to decide between the onboarding screen and the
    -- app itself, which is why it is a separate flag from `verified`: a
    -- verified account that has not picked a handle is mid-signup.
    'handle_set',    v_profile.handle_set_at is not null,
    'handle',        v_profile.handle,
    'name',          v_profile.display_name,
    'masked_phone',  case
                       when v_phone is null then null
                       else regexp_replace('+' || ltrim(v_phone, '+'),
                                           '^(\+\d{1,3})\d+(\d{2})$', '\1 •••• \2')
                     end
  );
end;
$$;


-- ----------------------------------------------------------------------------
-- Number recycling and re-registration
-- ----------------------------------------------------------------------------
-- Carriers reissue disconnected numbers, typically after months. So
-- "whoever controls this number" and "whoever owned this account" are the
-- same person only until they aren't, and the failure mode is somebody
-- receiving a stranger's messages.
--
-- Full mitigation needs a registration-lock PIN (Signal's answer) and is
-- not built here. What IS built is the part that limits the blast radius:
-- when a number verifies onto an account whose sessions predate that
-- verification, every earlier session is revoked and the DM key is
-- dropped. The new holder therefore cannot silently inherit a live session
-- on the old holder's device, and cannot read a single historical DM,
-- because the key that could is gone and the ciphertext is not decryptable
-- without it.
--
-- Called by the client immediately after a successful verify. It is
-- idempotent and safe to call on every sign-in, which is what makes it
-- correct to call unconditionally rather than trying to detect the
-- recycling case — a check that has to be right to be safe is worse than
-- an action that is harmless when unnecessary.
-- ----------------------------------------------------------------------------
create or replace function public.revoke_other_sessions()
  returns void
  language plpgsql
  volatile
  security definer
  set search_path = auth, public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    perform soso.fail('soso/unauthenticated');
  end if;

  -- Everything except the caller's own session. Deleting the current one
  -- would sign the user out of the device they are actively verifying on,
  -- which is not a security win, just a bug.
  --
  -- `id` is a uuid and the claim is text, so the cast is required rather
  -- than cosmetic. `is distinct from` rather than `<>` because a token
  -- without a session_id claim would make `<>` null, deleting nothing —
  -- failing open on exactly the path whose job is to revoke.
  delete from auth.sessions
  where user_id = v_uid
    and id::text is distinct from (auth.jwt() ->> 'session_id');

  -- The published public key belongs to a private key on a device that
  -- may no longer be the account holder's. Clearing it forces the next
  -- client that opens messaging to publish a fresh one, and until then
  -- `dm_public_key_of` returns null and nobody can encrypt to the stale
  -- key. Old ciphertext stays unreadable to everyone, which is the
  -- intended outcome, not a regression.
  delete from public.user_keys where user_id = v_uid;
end;
$$;


-- ----------------------------------------------------------------------------
-- Gating the abuse-prone writes: NOT IN THIS MIGRATION, AND NOT APPLIED
-- ----------------------------------------------------------------------------
-- The triggers that require a verified phone before posting, chatting,
-- messaging or following live in 20260908000032_require_verified_writes.sql,
-- which is currently held in `supabase/migrations-pending/` — OUTSIDE the
-- folder the CLI applies. So right now this migration adds the verification
-- machinery (the helpers, the signup RPCs, the `soso.require_verified` /
-- `soso.is_verified` predicates) but NOTHING enforces it: guest accounts
-- have the same access as verified ones, by choice.
--
-- That gating was split out and then held back for the same reason: it is
-- the one part of this feature that BREAKS AN EXISTING PROJECT the moment it
-- lands — every account without a confirmed phone loses the ability to
-- write instantly, and if SMS is not configured, nobody can verify either,
-- so there is no path back. This migration is therefore safe to apply on
-- its own, on a project with no SMS provider yet. To turn gating on, move
-- 0032 back into `supabase/migrations/` and push, once real codes can be
-- delivered; see that folder's README.
-- ----------------------------------------------------------------------------


-- ----------------------------------------------------------------------------
-- Profile bootstrap, revised
-- ----------------------------------------------------------------------------
-- Same job as migration 0005's version — every auth user gets a profile
-- row so nothing downstream deals with a missing one — with `handle_set_at`
-- left null so the client knows this account has not chosen a name yet.
-- The generated handle remains as a placeholder rather than being nullable,
-- because `profiles.handle` is `not null unique` and half the app joins on
-- it.
-- ----------------------------------------------------------------------------
create or replace function soso.tg_new_user()
  returns trigger
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
begin
  insert into public.profiles (id, handle, display_name, handle_set_at)
  values (
    new.id,
    'u' || substr(replace(new.id::text, '-', ''), 1, 12),
    coalesce(new.raw_user_meta_data ->> 'display_name', 'Soso User'),
    -- Anonymous sessions never run the signup screen, so marking them
    -- "set" keeps them out of an onboarding flow that would have nothing
    -- to attach the result to.
    case when new.phone is null then now() else null end
  )
  on conflict (id) do nothing;
  return new;
end;
$$;


-- ----------------------------------------------------------------------------
-- Grants. Explicit, because the default is EXECUTE to PUBLIC.
-- ----------------------------------------------------------------------------
revoke execute on function soso.phone_key(text) from anon, authenticated;
revoke execute on function soso.check_otp_throttle(text, text, text) from anon, authenticated;
revoke execute on function soso.record_otp_request(text, text, text) from anon, authenticated;

grant execute on function public.my_account() to anon, authenticated;
grant execute on function public.complete_signup(text, text) to authenticated;
grant execute on function public.handle_available(text) to authenticated;
grant execute on function public.revoke_other_sessions() to authenticated;
