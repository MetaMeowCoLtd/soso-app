"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ERROR_MESSAGES_EN,
  isWellFormedOtp,
  normalizeHandle,
  normalizePhone,
  OTP_LENGTH,
  type PhoneProblem,
} from "soso-core";
import {
  completeSignup,
  currentCooldownSeconds,
  DEFAULT_COUNTRY_CODE,
  isHandleAvailable,
  sendCode,
  verifyCode,
  type Account,
} from "./auth";

/**
 * The three screens of signing in: number, code, name.
 *
 * There is no "sign up" screen and no "log in" screen, because there is no
 * such distinction to make — `sendCode` creates the account if the number
 * is new and signs in if it isn't, and this component never learns which
 * happened. That is what makes it impossible for the UI to leak whether a
 * number is registered: there is nothing here that knows. The third screen
 * appears based on `handleSet` from `my_account`, which is only readable
 * once the caller is already authenticated.
 *
 * COPY RULES THAT ARE SECURITY RULES
 * ---------------------------------------------------------------------
 * Nothing on the first two screens may ever say "account not found",
 * "welcome back", or anything else that differs between a known and an
 * unknown number — including the button label, which is why it reads
 * "Continue" rather than either "Sign up" or "Log in". A wrong code and an
 * unregistered number produce the same message for the same reason.
 */

interface AuthScreensProps {
  /** Null until verified; supplies the handle step once it isn't. */
  account: Account | null;
  onAuthenticated: () => void;
  /** Lets someone look at the map without an account. Null hides the option entirely. */
  onSkip?: (() => void) | null;
}

const PHONE_PROBLEMS: Record<PhoneProblem, string> = {
  empty: "Enter your phone number.",
  bad_characters: "That has characters a phone number can't contain.",
  no_country_code: "Include your country code, like +81.",
  too_short: "That number looks too short.",
  too_long: "That number looks too long.",
  malformed: "That doesn't look like a phone number.",
};

function messageFor(code: string | undefined): string {
  if (!code) return ERROR_MESSAGES_EN["soso/unknown"];
  if (code === "soso/invalid_code") return "That code isn't right. Check it and try again.";
  return code in ERROR_MESSAGES_EN
    ? ERROR_MESSAGES_EN[code as keyof typeof ERROR_MESSAGES_EN]
    : ERROR_MESSAGES_EN["soso/unknown"];
}

export default function AuthScreens({ account, onAuthenticated, onSkip }: AuthScreensProps) {
  // A verified account that hasn't named itself is mid-signup, so it lands
  // on the handle step rather than back at the number it just verified.
  const [step, setStep] = useState<"phone" | "code" | "handle">(
    account?.verified && !account.handleSet ? "handle" : "phone",
  );
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (account?.verified && !account.handleSet) setStep("handle");
  }, [account?.verified, account?.handleSet]);

  // One second tick, only while a cooldown is actually running — a timer
  // that keeps firing on a settled screen is a wakelock nobody asked for.
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setInterval(() => setCooldown(currentCooldownSeconds()), 1000);
    return () => window.clearInterval(timer);
  }, [cooldown]);

  const parsedPhone = useMemo(() => normalizePhone(phone, DEFAULT_COUNTRY_CODE), [phone]);

  async function submitPhone(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    // try/finally, not a bare await: `busy` disables this button, so ANY
    // throw that skips `setBusy(false)` leaves the screen stuck on
    // "Sending…" with nothing to press and no error explaining why. That
    // is not hypothetical — `getSupabase()` throws synchronously on a
    // misconfigured project, and it stranded this screen exactly that way
    // before the guard existed. The finally makes the class of bug
    // impossible rather than fixing the one instance of it.
    try {
      const result = await sendCode(phone);
      setCooldown(result.cooldownSeconds);
      if (!result.ok) {
        setError(result.phoneProblem ? PHONE_PROBLEMS[result.phoneProblem] : messageFor(result.errorCode));
        return;
      }
      setCode("");
      setStep("code");
    } catch {
      setError(messageFor("soso/unreachable"));
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !isWellFormedOtp(code)) return;
    setBusy(true);
    setError(null);
    try {
      const result = await verifyCode(phone, code);
      if (!result.ok) {
        setError(messageFor(result.errorCode));
        return;
      }
      onAuthenticated();
    } catch {
      setError(messageFor("soso/unreachable"));
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    if (busy || cooldown > 0) return;
    setBusy(true);
    setError(null);
    try {
      const result = await sendCode(phone);
      setCooldown(result.cooldownSeconds);
      if (!result.ok) setError(messageFor(result.errorCode));
    } catch {
      setError(messageFor("soso/unreachable"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        {step === "phone" && (
          <form onSubmit={submitPhone} noValidate>
            <p className="auth-kicker">Welcome to</p>
            <h1 className="auth-title">
              <span>So</span>So
            </h1>
            <p className="auth-lede">
              Enter your phone number. We&rsquo;ll text you a {OTP_LENGTH}-digit code to make sure
              it&rsquo;s yours.
            </p>

            <label className="auth-field">
              <span>Phone number</span>
              <input
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                autoFocus
                placeholder="090 1234 5678"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                aria-invalid={phone.length > 0 && !parsedPhone.ok}
              />
            </label>
            <p className="auth-hint">
              Numbers without a country code are treated as Japanese (+{DEFAULT_COUNTRY_CODE}).
            </p>

            {error && <p className="auth-error">{error}</p>}

            {/* "Continue", never "Sign up" or "Log in" — the label must not
                reveal whether this number already has an account. */}
            <button type="submit" className="auth-primary" disabled={busy || !parsedPhone.ok}>
              {busy ? "Sending…" : "Continue"}
            </button>

            {onSkip && (
              <button type="button" className="auth-secondary" onClick={onSkip}>
                Continue as guest
              </button>
            )}

            {/* No claim here that guest activity carries over into a real
                account, because it does not: `signInWithOtp` signs into the
                account that owns the NUMBER, which replaces the anonymous
                session rather than adopting it, and anything the guest
                session created stays on the orphaned account. Once
                migration 0032 is applied a guest cannot create anything in
                the first place, so there is nothing to strand — until then
                there is, and promising otherwise would be a lie with a
                data-loss shape. */}
            <p className="auth-fineprint">
              Your number is used to verify this account and is never shown to anyone else.
              {onSkip && " Guest activity stays on the guest account and doesn't move over when you sign in."}
            </p>
          </form>
        )}

        {step === "code" && (
          <form onSubmit={submitCode} noValidate>
            <button
              type="button"
              className="auth-back"
              onClick={() => {
                setStep("phone");
                setError(null);
              }}
            >
              ← Change number
            </button>
            <h2 className="auth-heading">Enter your code</h2>
            <p className="auth-lede">
              We sent {OTP_LENGTH} digits to <strong>{parsedPhone.ok ? parsedPhone.phone.e164 : phone}</strong>.
            </p>

            <label className="auth-field">
              <span>Verification code</span>
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                maxLength={OTP_LENGTH}
                placeholder="123456"
                className="auth-code-input"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\s/g, ""))}
              />
            </label>

            {error && <p className="auth-error">{error}</p>}

            <button type="submit" className="auth-primary" disabled={busy || !isWellFormedOtp(code)}>
              {busy ? "Checking…" : "Verify"}
            </button>

            <button
              type="button"
              className="auth-secondary"
              onClick={resend}
              disabled={busy || cooldown > 0}
            >
              {cooldown > 0 ? `Resend in ${cooldown}s` : "Send a new code"}
            </button>
          </form>
        )}

        {step === "handle" && <HandleStep onDone={onAuthenticated} />}
      </div>
    </div>
  );
}

/**
 * The one screen that only a first-time account sees. Reached from
 * `handleSet: false` on an already-verified session, so it cannot be used
 * to probe anything: you have to hold a valid session to get here at all.
 */
function HandleStep({ onDone }: { onDone: () => void }) {
  const [handle, setHandle] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);
  const checkSeq = useRef(0);

  const parsed = useMemo(() => normalizeHandle(handle), [handle]);

  // Debounced, and guarded by a sequence number so a slow early response
  // cannot overwrite the verdict for what is now a different handle.
  useEffect(() => {
    if (!parsed.ok) {
      setAvailable(null);
      return;
    }
    const seq = ++checkSeq.current;
    const timer = window.setTimeout(async () => {
      const result = await isHandleAvailable(parsed.handle);
      if (seq === checkSeq.current) setAvailable(result);
    }, 400);
    return () => window.clearTimeout(timer);
  }, [parsed]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !parsed.ok || name.trim().length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const result = await completeSignup(parsed.handle, name.trim());
      if (!result.ok) {
        setError(messageFor(result.errorCode));
        return;
      }
      onDone();
    } catch {
      setError(messageFor("soso/unreachable"));
    } finally {
      setBusy(false);
    }
  }

  const handleProblem =
    handle.length > 0 && !parsed.ok
      ? {
          empty: "",
          too_short: "At least 3 characters.",
          too_long: "At most 20 characters.",
          bad_characters: "Letters, numbers and underscore only.",
          reserved: "That username isn't available.",
        }[parsed.problem]
      : null;

  return (
    <form onSubmit={submit} noValidate>
      <h2 className="auth-heading">Pick your name</h2>
      <p className="auth-lede">
        Your username is how people find and mention you. Your display name is what they see.
      </p>

      <label className="auth-field">
        <span>Display name</span>
        <input
          type="text"
          autoComplete="name"
          autoFocus
          maxLength={40}
          placeholder="Your name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>

      <label className="auth-field">
        <span>Username</span>
        <input
          type="text"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          maxLength={20}
          placeholder="yourname"
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
          aria-invalid={handleProblem !== null}
        />
      </label>

      {handleProblem ? (
        <p className="auth-hint auth-hint-bad">{handleProblem}</p>
      ) : available === false ? (
        <p className="auth-hint auth-hint-bad">That username is taken.</p>
      ) : available === true ? (
        <p className="auth-hint auth-hint-ok">@{parsed.ok ? parsed.handle : ""} is available.</p>
      ) : (
        <p className="auth-hint">3–20 characters: a–z, 0–9 and underscore.</p>
      )}

      {error && <p className="auth-error">{error}</p>}

      <button
        type="submit"
        className="auth-primary"
        disabled={busy || !parsed.ok || name.trim().length === 0 || available === false}
      >
        {busy ? "Saving…" : "Finish"}
      </button>
    </form>
  );
}
