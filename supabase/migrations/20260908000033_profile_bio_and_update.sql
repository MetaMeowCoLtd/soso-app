-- ============================================================================
-- 0033  Profile bio + a way to edit your own profile
-- ============================================================================
--
-- Until now a display name could only be set once, at signup
-- (`complete_signup`, migration 0031), and there was no bio at all. The
-- profile settings screen needs both editable, so this adds the column and
-- the one RPC that changes them.
--
-- HANDLE IS DELIBERATELY NOT EDITABLE HERE
-- ---------------------------------------------------------------------
-- `update_profile` touches display_name and bio, never handle. A handle
-- rename that frees the old name for anyone to claim is an impersonation
-- vector — take the handle someone just vacated, inherit their mentions —
-- and doing it safely needs a reservation/cooldown period this app has no
-- reason to build yet. Signup claims the handle once; this changes only the
-- parts that are safe to change freely.
--
-- UNVERIFIED — reviewed, not executed, same as every migration since 0025.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- profiles.bio
-- ----------------------------------------------------------------------------
-- `not null default ''` rather than nullable: "no bio" and "" render
-- identically and mean the same thing, so a nullable column would only add
-- a second empty state for every reader to special-case. The 160 ceiling
-- mirrors `BIO_MAX` in packages/core/src/domain/profile.ts, and the two
-- must stay in step — the client validates against that constant for a live
-- character counter, and this check is what actually enforces it.
-- ----------------------------------------------------------------------------
alter table public.profiles
  add column if not exists bio text not null default '' check (length(bio) <= 160);


-- ----------------------------------------------------------------------------
-- my_profile — now carries bio
-- ----------------------------------------------------------------------------
-- Restated in whole from migration 0016 (the coins version) with `bio`
-- added, because `create or replace function` cannot add a key to the
-- returned jsonb without rewriting the body. Everything else is identical:
-- same SECURITY INVOKER, same coin balance, same one-row lookup.
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
    'bio',     p.bio,
    'coins',   p.coin_balance
  )
  from public.profiles p
  where p.id = auth.uid();
$$;


-- ----------------------------------------------------------------------------
-- update_profile — the edit
-- ----------------------------------------------------------------------------
-- SECURITY DEFINER and scoped to `auth.uid()`: a caller can only ever edit
-- their own row, and the id is taken from the verified JWT, never from a
-- parameter, so there is no id to spoof. Validation mirrors the domain
-- module and the column checks so the failure is a clean coded error rather
-- than a raw constraint violation.
--
-- Trims before storing, matching `validateDisplayName`/`validateBio`: the
-- stored value is the trimmed one, so what comes back from `my_profile`
-- next is exactly what was written, with no surprise leading spaces.
-- ----------------------------------------------------------------------------
create or replace function public.update_profile(
  p_display_name text,
  p_bio          text
)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_uid  uuid := auth.uid();
  v_name text := trim(coalesce(p_display_name, ''));
  v_bio  text := trim(coalesce(p_bio, ''));
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

  update public.profiles
     set display_name = v_name,
         bio = v_bio
   where id = v_uid;

  -- Same shape my_profile returns, so the gateway decodes both with one
  -- decoder and the caller can render the saved row without a second fetch.
  return (
    select jsonb_build_object(
      'id',     p.id,
      'handle', p.handle,
      'name',   p.display_name,
      'bio',    p.bio,
      'coins',  p.coin_balance
    )
    from public.profiles p
    where p.id = v_uid
  );
end;
$$;


-- Grants. Explicit, because the default is EXECUTE to PUBLIC.
grant execute on function public.update_profile(text, text) to authenticated;
