/**
 * Phone-number authentication.
 *
 * Ported from apps/web/src/web/auth.ts. Sign-up and sign-in are ONE code
 * path, not two — see that file's module comment for why: `signInWithOtp`
 * creates the account if the number is new and signs into the existing one
 * if it isn't, and this module never asks which happened before sending
 * the code. That is what makes user enumeration structurally impossible,
 * not a rule to remember.
 *
 * The only mechanical change from the web version is `isGuest`/`setGuest`:
 * `AsyncStorage` has no synchronous read, so both become `Promise`-returning
 * — every caller already awaits or will await them, since there was no
 * synchronous call site to preserve (AuthScreens itself never touches
 * storage directly; a screen orchestrating guest mode calls these).
 */

import {
  normalizeOtp,
  normalizePhone,
  resendCooldownSeconds,
  type PhoneProblem,
} from "../core";
import { currentUserId, getSupabase, startGuestSession } from "./supabase";
import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * Numbers typed without a country code are assumed to be in this one.
 * Japan, because that is where this app's map, its categories and its
 * Japanese-language labels are aimed. Someone typing a `+` is always taken
 * at their word instead (see `normalizePhone`).
 */
export const DEFAULT_COUNTRY_CODE = "81";

/**
 * Ceiling on how long either network call may sit before it is treated as
 * failed. See apps/web's identical constant for the full rationale: a
 * request that hangs is the normal shape of a bad mobile connection, and
 * without this the UI has a `busy` state it can never leave.
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
 * Whether this device has chosen to use the app without an account.
 *
 * Persisted rather than held in React state, for the same reason as web:
 * the alternative is a phone-number wall on every single launch for someone
 * who has already said no to it once. It records a UI preference and
 * grants nothing — what a guest session may actually do is decided by the
 * database, not by this flag.
 */
const GUEST_KEY = "soso-guest";

export async function isGuest(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(GUEST_KEY)) === "1";
  } catch {
    // Falling back to "not a guest" shows the sign-in screen, which is the
    // recoverable direction to be wrong in — the alternative silently
    // hides the way to sign in.
    return false;
  }
}

export async function setGuest(on: boolean): Promise<void> {
  try {
    if (on) await AsyncStorage.setItem(GUEST_KEY, "1");
    else await AsyncStorage.removeItem(GUEST_KEY);
  } catch {
    // Nothing to do: the session still works for this launch, it just
    // won't be remembered on the next one.
  }
}

/**
 * Gives a guest the anonymous session their choice implies, creating one
 * only if this device doesn't already have a session of any kind.
 */
export async function ensureGuestSession(): Promise<boolean> {
  return (await startGuestSession()) !== null;
}

export interface SendCodeResult {
  ok: boolean;
  /** Seconds before another send is allowed — drives the countdown on the resend button. */
  cooldownSeconds: number;
  errorCode?: string;
  phoneProblem?: PhoneProblem;
}

/**
 * How many codes this launch has asked for, so the resend countdown can
 * lengthen the way the server's own throttle does. Deliberately in memory
 * and not persisted — see apps/web's identical note: the limit that
 * actually decides is server-side, this only renders an honest button
 * state, and persisting it would punish a relaunch twice for one send.
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

  let error: { status?: number; message?: string } | null = null;
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
    // The user-facing copy is deliberately vague (it must not leak whether
    // a number is registered), but the DEVELOPER needs the real reason —
    // logged, not shown.
    console.warn("[soso] signInWithOtp failed:", error.status, error.message);
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
 * See apps/web's identical function for the full rationale on why a
 * successful verify does NOT revoke other sessions any more — that RPC is
 * kept, unchanged, for a deliberate "sign out of other devices" action
 * elsewhere, not fired automatically here.
 */
export async function verifyCode(rawPhone: string, code: string): Promise<VerifyResult> {
  const parsed = normalizePhone(rawPhone, DEFAULT_COUNTRY_CODE);
  if (!parsed.ok) return { ok: false, errorCode: "soso/bad_request" };

  // getSupabase() is INSIDE the try, not above it — it throws synchronously
  // when the project isn't configured, and outside the guard that leaves
  // the caller's `busy` flag stuck true forever. See apps/web's identical
  // note; this bug was found there first.
  let supabase: ReturnType<typeof getSupabase>;
  let error: { status?: number; message?: string } | null = null;
  try {
    supabase = getSupabase();
    ({ error } = await withTimeout(
      // normalizeOtp, not code.trim(): the button was enabled against the
      // folded form, so the folded form is what must be sent, or full-width
      // IME digits are rejected as a wrong code.
      supabase.auth.verifyOtp({ phone: parsed.phone.e164, token: normalizeOtp(code), type: "sms" }),
    ));
  } catch {
    return { ok: false, errorCode: "soso/unreachable" };
  }

  if (error) {
    console.warn("[soso] verifyOtp failed:", error.status, error.message);
    return {
      ok: false,
      errorCode: error.status === 429 ? "soso/otp_rate_limited" : "soso/invalid_code",
    };
  }

  resetCooldown();
  // Signing in ends guest mode, so the next launch doesn't skip straight
  // past the account that was just verified.
  await setGuest(false);

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
  // Awaited FIRST — see apps/web's identical note: restoring a persisted
  // session from storage is asynchronous, and `my_account` reads a caller
  // it hasn't finished restoring as anonymous. `currentUserId` resolves
  // only once that restore has completed, turning the race into a wait.
  if (!(await currentUserId())) return null;

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
}

/**
 * Fires on sign-in, sign-out, token refresh and cross-tab session changes
 * (here: any other place in this app holding a client). Returns its own
 * unsubscribe.
 */
export function onAuthChange(handler: (userId: string | null) => void): () => void {
  const { data } = getSupabase().auth.onAuthStateChange((_event, session) => {
    handler(session?.user?.id ?? null);
  });
  return () => data.subscription.unsubscribe();
}
