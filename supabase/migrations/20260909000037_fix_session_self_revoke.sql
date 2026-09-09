-- ============================================================================
-- 0037  Stop revoke_other_sessions from revoking the CURRENT session
-- ============================================================================
--
-- Symptom this fixes: signing in with a phone number worked, and then every
-- subsequent launch of the app demanded verification again, forever.
--
-- WHAT WENT WRONG
-- ---------------------------------------------------------------------
-- 0031's version deletes every session for the user except the caller's own,
-- identified by matching `auth.jwt() ->> 'session_id'`. It used
-- `is distinct from` rather than `<>` on purpose, so that a token with NO
-- session_id claim would not silently delete nothing — the reasoning being
-- that failing open on the one function whose job is revocation is worse
-- than failing closed.
--
-- But "failing closed" here does not mean revoking a bit too eagerly. With
-- the claim absent, `id::text is distinct from null` is TRUE for every row,
-- so the predicate matches EVERY session — including the session belonging
-- to the device that is, at that exact moment, in the middle of signing in.
-- The client calls this immediately after a successful verify, so the effect
-- is that verifying signs you out of the device you just verified on. The
-- damage only becomes visible on the next launch, when the refresh token is
-- found dead and the app asks for the phone number again — which, when you
-- verify, calls this again. That is a loop with no exit, and no amount of
-- verifying escapes it.
--
-- THE FIX, AND WHY THIS DIRECTION IS THE SAFE ONE
-- ---------------------------------------------------------------------
-- When the claim is missing we now delete NOTHING from auth.sessions, and
-- still drop the DM key. That is a deliberate reversal of 0031's tradeoff,
-- on the grounds that its risk assessment had the two failure modes the
-- wrong way round:
--
--   * Failing open costs: on a token with no session_id, a stale session on
--     some other device outlives a re-registration it should not have. Rare
--     (it needs number recycling AND a claimless token) and bounded — the
--     user_keys delete below still happens unconditionally, so no historical
--     DM is readable either way, which was always the part that actually
--     protected the previous owner.
--
--   * Failing closed costs: EVERY user, on EVERY sign-in, on a deployment
--     whose tokens lack the claim, is logged out immediately and cannot stay
--     logged in at all. That is not a conservative security posture; it is a
--     total loss of the ability to hold a session, which pushes people toward
--     exactly the weaker workarounds ("just remember me forever", "let me use
--     a password") that this app's auth design exists to avoid.
--
-- Current Supabase Auth does put `session_id` in access tokens, so on a
-- healthy deployment the behaviour is unchanged and every other session is
-- still revoked. This only changes what happens when the claim is absent.
--
-- UNVERIFIED — reviewed, not executed, same as every migration since 0025.
-- ============================================================================

create or replace function public.revoke_other_sessions()
  returns void
  language plpgsql
  volatile
  security definer
  set search_path = auth, public, pg_temp
as $$
declare
  v_uid        uuid := auth.uid();
  v_session_id text := auth.jwt() ->> 'session_id';
begin
  if v_uid is null then
    perform soso.fail('soso/unauthenticated');
  end if;

  -- Only when we can actually identify the caller's own session to spare it.
  -- See the header: with no claim to compare against there is no way to
  -- express "all except mine", and deleting all of them logs this device out
  -- mid-sign-in rather than protecting anybody.
  if v_session_id is not null then
    delete from auth.sessions
    where user_id = v_uid
      and id::text <> v_session_id;
  end if;

  -- Unconditional, claim or no claim. This is the half that actually stops a
  -- new holder of a recycled number from reading the previous holder's
  -- messages: without the published key, nobody can encrypt to the stale
  -- device, and existing ciphertext stays unreadable to everyone.
  delete from public.user_keys where user_id = v_uid;
end;
$$;

grant execute on function public.revoke_other_sessions() to authenticated;
