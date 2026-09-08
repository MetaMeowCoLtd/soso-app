/**
 * Phone-number authentication.
 *
 * Sign-up and sign-in are ONE code path, not two. `signInWithOtp` creates
 * the account if the number is new and signs into the existing one if it
 * isn't, and this module never asks which happened before sending the
 * code. That is not a shortcut — it is what makes user enumeration
 * structurally impossible here rather than a rule someone has to remember:
 * there is no branch to leak, because the server genuinely does the same
 * thing either way. The screens differ afterwards (a first-time account
 * gets the handle step), but that decision is made from `my_account` AFTER
 * authentication, never from anything shown to an unauthenticated caller.
 *
 * WHY THE CODE ITSELF IS NOT GENERATED HERE
 * ---------------------------------------------------------------------
 * Supabase's phone provider generates it, stores only its hash, expires
 * it, and burns it on first use. Reimplementing that would mean
 * reimplementing it worse — the same reasoning that puts the DM cipher on
 * SubtleCrypto rather than hand-written primitives. What this file adds is
 * the part the platform cannot know: honest cooldown state for the UI, and
 * the account-switch cleanup below.
 *
 * THE ACCOUNT-SWITCH BUG THIS FILE EXISTS TO PREVENT
 * ---------------------------------------------------------------------
 * Before this feature, one browser meant one permanent anonymous account,
 * so `dmCrypto`'s keystore could store the private key under a fixed
 * record id and never be wrong. The moment sign-out and sign-in exist that
 * stops being true, and the failure is severe rather than cosmetic: user A
 * signs out, user B signs in on the same browser, and `getSelfKeys()`
 * hands B the private key belonging to A — after which
 * `ensurePublishedKey` publishes A's PUBLIC key as B's, and everyone
 * messaging B encrypts to a key only A can open.
 *
 * `syncKeystoreToAccount` below is the fix, and it runs on every auth
 * state change rather than only on sign-out, because the sign-out half can
 * be skipped entirely — closing the tab, clearing a cookie, or a refresh
 * token expiring all end one session and start another with no sign-out
 * event in between.
 */

"use client";

import {
  normalizeOtp,
  normalizePhone,
  resendCooldownSeconds,
  type PhoneProblem,
} from "soso-core";
import { forgetSelfKeys } from "./dmCrypto";
import { getSupabase } from "./supabase";

/**
 * Numbers typed without a country code are assumed to be in this one.
 * Japan, because that is where this app's map, its categories and its
 * Japanese-language labels are aimed. Someone typing a `+` is always taken
 * at their word instead (see `normalizePhone`).
 */
export const DEFAULT_COUNTRY_CODE = "81";

/**
 * Ceiling on how long either network call may sit before it is treated as
 * failed.
 *
 * Without this the UI has a state it cannot leave: `busy` goes true, the
 * button disables itself and reads "Checking…", and if the request never
 * settles neither does the screen. There is no error, no retry, and no way
 * back — the only escape is reloading the page, which is not a thing a
 * button should ever require. A request that hangs is the normal shape of
 * a bad mobile connection, so this is the common failure, not the exotic
 * one.
 *
 * `resolveGateway` already makes exactly this argument for exactly this
 * reason (see `withTimeout` in bootstrap.ts); this is the same discipline
 * applied to the two calls that stand between someone and their account.
 * Twelve seconds is well past a slow-but-working round trip and well short
 * of the point where a person concludes the app is broken.
 */
const REQUEST_TIMEOUT_MS = 12_000;

class TimeoutError extends Error {}

function withTimeout<T>(work: PromiseLike<T>, ms = REQUEST_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError("timed out")), ms);
    Promise.resolve(work).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export type AuthStep = "phone" | "code" | "handle" | "done";

/**
 * Whether this browser has chosen to use the app without an account.
 *
 * Persisted rather than held in React state because the alternative is a
 * phone-number wall on every single reload for someone who has already
 * said no to it once — which is not a security control, just an
 * obstruction. It records a UI preference and grants nothing: what a guest
 * session may actually do is decided by the database (see migration 0032),
 * not by this flag, so setting it by hand in devtools buys an attacker
 * exactly the anonymous session they could already have had.
 */
const GUEST_KEY = "soso-guest";

export function isGuest(): boolean {
  try {
    return window.localStorage.getItem(GUEST_KEY) === "1";
  } catch {
    // Private mode, or site data blocked. Falling back to "not a guest"
    // shows the sign-in screen, which is the recoverable direction to be
    // wrong in — the alternative silently hides the way to sign in.
    return false;
  }
}

export function setGuest(on: boolean): void {
  try {
    if (on) window.localStorage.setItem(GUEST_KEY, "1");
    else window.localStorage.removeItem(GUEST_KEY);
  } catch {
    // Nothing to do: the session still works for this tab, it just won't
    // be remembered across a reload.
  }
}

export interface SendCodeResult {
  ok: boolean;
  /** Seconds before another send is allowed — drives the countdown on the resend button. */
  cooldownSeconds: number;
  errorCode?: string;
  phoneProblem?: PhoneProblem;
}

/**
 * How many codes this browser has asked for, so the resend countdown can
 * lengthen the way the server's own throttle does. Deliberately in memory
 * and not persisted: this exists to render an honest button state, and the
 * limit that actually decides is `soso.check_otp_throttle` in migration
 * 0031. Persisting it would only mean a user who reloads the page gets
 * punished twice for one send.
 */
let sendsThisSession = 0;
let lastSendAt = 0;

export function currentCooldownSeconds(): number {
  if (sendsThisSession === 0) return 0;
  const elapsed = (Date.now() - lastSendAt) / 1000;
  return Math.max(0, Math.ceil(resendCooldownSeconds(sendsThisSession) - elapsed));
}

export function resetCooldown(): void {
  sendsThisSession = 0;
  lastSendAt = 0;
}

/**
 * Sends a verification code, or explains why it didn't.
 *
 * `shouldCreateUser` is left at its default (true) precisely because this
 * is both signup and login — turning it off would make the call behave
 * differently for a number that has an account than for one that doesn't,
 * which is the enumeration oracle the single-path design exists to avoid.
 */
export async function sendCode(rawPhone: string): Promise<SendCodeResult> {
  const parsed = normalizePhone(rawPhone, DEFAULT_COUNTRY_CODE);
  if (!parsed.ok) {
    return { ok: false, cooldownSeconds: 0, phoneProblem: parsed.problem };
  }

  const remaining = currentCooldownSeconds();
  if (remaining > 0) {
    return { ok: false, cooldownSeconds: remaining, errorCode: "soso/otp_cooldown" };
  }

  let error: { status?: number } | null = null;
  try {
    ({ error } = await withTimeout(
      getSupabase().auth.signInWithOtp({ phone: parsed.phone.e164 }),
    ));
  } catch {
    // A timeout or a thrown transport error. Reported as "couldn't reach"
    // rather than as a rejection of the number, because the number may be
    // perfectly fine and telling someone to fix it would send them to
    // change something that isn't wrong.
    return { ok: false, cooldownSeconds: currentCooldownSeconds(), errorCode: "soso/unreachable" };
  }

  if (error) {
    // Supabase's own rate limiter answers with 429 before ours is even
    // consulted. Surfaced as the same code the database uses so the UI has
    // one message for "too many", not one per layer that can say it.
    const code = error.status === 429 ? "soso/otp_rate_limited" : "soso/unknown";
    return { ok: false, cooldownSeconds: currentCooldownSeconds(), errorCode: code };
  }

  sendsThisSession += 1;
  lastSendAt = Date.now();
  return { ok: true, cooldownSeconds: currentCooldownSeconds() };
}

export interface VerifyResult {
  ok: boolean;
  errorCode?: string;
}

/**
 * Exchanges the code for a session.
 *
 * On success this ALSO revokes every other session on the account and
 * clears the published DM key, unconditionally. That looks aggressive for
 * an ordinary sign-in, and it is the point: carriers reissue disconnected
 * numbers, so "controls this number" and "owns this account" are the same
 * person right up until they aren't. Doing it every time means the
 * recycling case needs no detection — and a check that has to be correct
 * to be safe is worse than an action that is merely redundant when it
 * isn't needed.
 *
 * The visible cost is that signing in on a new phone signs you out of your
 * old one and loses your DM history. That is Signal's behaviour and it is
 * the honest consequence of keys that never leave the device that made
 * them; see the README's "What signing in on a new device costs you".
 */
export async function verifyCode(rawPhone: string, code: string): Promise<VerifyResult> {
  const parsed = normalizePhone(rawPhone, DEFAULT_COUNTRY_CODE);
  if (!parsed.ok) return { ok: false, errorCode: "soso/bad_request" };

  // getSupabase() is INSIDE the try, not above it. It throws synchronously
  // ("supabaseUrl is required") when the project isn't configured, and with
  // that call outside the guard the whole function rejected — leaving the
  // caller's `busy` flag stuck true and the button disabled at "Checking…"
  // with no error and no way back.
  let supabase: ReturnType<typeof getSupabase>;
  let error: { status?: number } | null = null;
  try {
    supabase = getSupabase();
    ({ error } = await withTimeout(
      // normalizeOtp, not code.trim(): the button was enabled against the
      // folded form, so the folded form is what must be sent, or full-width
      // IME digits are rejected as a wrong code. See normalizeOtp's comment.
      supabase.auth.verifyOtp({ phone: parsed.phone.e164, token: normalizeOtp(code), type: "sms" }),
    ));
  } catch {
    // Distinct from a wrong code on purpose. "That code isn't right" would
    // send someone to re-read an SMS that was never the problem, and — the
    // worse half — they would burn attempts against a limit that does bite,
    // on a request the server never received.
    return { ok: false, errorCode: "soso/unreachable" };
  }

  if (error) {
    return {
      ok: false,
      errorCode: error.status === 429 ? "soso/otp_rate_limited" : "soso/invalid_code",
    };
  }

  resetCooldown();
  // Signing in ends guest mode, so the next reload doesn't skip straight
  // past the account that was just verified.
  setGuest(false);

  // Best-effort: a failure here must not strand someone outside an account
  // they have just proven they control. It is a hardening step, not part
  // of authenticating, and it retries on the next sign-in. (try/catch
  // rather than `.catch()` because a PostgREST builder is a thenable, not
  // a Promise, and has no such method.)
  try {
    await supabase.rpc("revoke_other_sessions");
  } catch {
    // Retried on the next sign-in.
  }

  return { ok: true };
}

export interface Account {
  id: string;
  verified: boolean;
  /** False for a verified account that has not picked a handle — i.e. mid-signup. */
  handleSet: boolean;
  handle: string | null;
  name: string | null;
  /** Already masked by the server; the raw number never reaches this client. */
  maskedPhone: string | null;
}

export async function loadAccount(): Promise<Account | null> {
  const { data, error } = await getSupabase().rpc("my_account");
  if (error || !data) return null;
  const row = data as {
    id: string;
    verified: boolean;
    handle_set: boolean;
    handle: string | null;
    name: string | null;
    masked_phone: string | null;
  };
  return {
    id: row.id,
    verified: row.verified,
    handleSet: row.handle_set,
    handle: row.handle,
    name: row.name,
    maskedPhone: row.masked_phone,
  };
}

export async function completeSignup(
  handle: string,
  displayName: string,
): Promise<{ ok: boolean; errorCode?: string }> {
  const { error } = await getSupabase().rpc("complete_signup", {
    p_handle: handle,
    p_display_name: displayName,
  });
  if (error) {
    const code = (error as { message?: string }).message ?? "";
    return { ok: false, errorCode: code.startsWith("soso/") ? code : "soso/unknown" };
  }
  return { ok: true };
}

/** For the "that one's taken" hint. Failures read as "can't tell", never as "available". */
export async function isHandleAvailable(handle: string): Promise<boolean | null> {
  const { data, error } = await getSupabase().rpc("handle_available", { p_handle: handle });
  if (error) return null;
  return data === true;
}

export async function signOut(): Promise<void> {
  await getSupabase().auth.signOut();
  // Not conditional on the sign-out succeeding: if the network call failed
  // the local session is still gone, and leaving a private key behind for
  // whoever signs in next is the failure mode this whole module is here to
  // prevent.
  await forgetSelfKeys();
}

/**
 * Drops this browser's DM keystore whenever it belongs to a different
 * account than the one now signed in. See the module comment for the
 * cross-account key confusion this prevents.
 *
 * Deliberately compares against the id the keystore itself recorded rather
 * than tracking the previous session in memory — memory does not survive
 * the reload that a sign-in causes, and the stale key does.
 */
export async function syncKeystoreToAccount(userId: string | null): Promise<void> {
  await forgetSelfKeys(userId);
}

/**
 * Fires on sign-in, sign-out, token refresh and tab-to-tab session
 * changes. Returns its own unsubscribe.
 */
export function onAuthChange(handler: (userId: string | null) => void): () => void {
  const { data } = getSupabase().auth.onAuthStateChange((_event, session) => {
    const userId = session?.user?.id ?? null;
    void syncKeystoreToAccount(userId);
    handler(userId);
  });
  return () => data.subscription.unsubscribe();
}
