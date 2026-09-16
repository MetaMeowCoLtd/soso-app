import { useEffect, useMemo, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  TextInput,
  View,
} from "react-native";

import {
  ERROR_MESSAGES_EN,
  isWellFormedOtp,
  normalizeHandle,
  normalizePhone,
  OTP_LENGTH,
  type PhoneProblem,
} from "../core";
import {
  completeSignup,
  currentCooldownSeconds,
  DEFAULT_COUNTRY_CODE,
  isHandleAvailable,
  sendCode,
  verifyCode,
  type Account,
} from "../data/auth";
import { COLORS } from "../theme/tokens";
import { AppText } from "../ui/AppText";
import { Button } from "../ui/Button";

/**
 * Ported from apps/web/src/web/AuthScreens.tsx — the three screens of
 * signing in: number, code, name. There is no "sign up" screen and no "log
 * in" screen, because there is no such distinction to make. See the web
 * version's module comment for the full rationale on why the button reads
 * "Continue" rather than either "Sign up" or "Log in" — nothing on the
 * first two screens may ever differ between a known and an unknown number,
 * including copy, or the UI itself becomes a way to check whether a phone
 * number has an account.
 *
 * `window.setInterval`/`clearInterval` become the plain global versions —
 * RN has no `window`. Everything else is the same state machine as web.
 */

interface AuthScreensProps {
  /** Null until verified; supplies the handle step once it isn't. */
  account: Account | null;
  onAuthenticated: () => void;
  /** Lets someone look at the map without an account. Undefined hides the option entirely. */
  onSkip?: () => void;
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
    const timer = setInterval(() => setCooldown(currentCooldownSeconds()), 1000);
    return () => clearInterval(timer);
  }, [cooldown]);

  const parsedPhone = useMemo(() => normalizePhone(phone, DEFAULT_COUNTRY_CODE), [phone]);

  async function submitPhone() {
    if (busy) return;
    setBusy(true);
    setError(null);
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

  async function submitCode() {
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
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={styles.card}>
        {step === "phone" && (
          <View>
            <AppText style={styles.kicker}>Welcome to</AppText>
            <AppText style={styles.title}>SoSo</AppText>
            <AppText style={styles.lede}>
              Enter your phone number. We&rsquo;ll text you a {OTP_LENGTH}-digit code to make sure
              it&rsquo;s yours.
            </AppText>

            <AppText style={styles.fieldLabel}>Phone number</AppText>
            <TextInput
              style={[styles.input, phone.length > 0 && !parsedPhone.ok && styles.inputInvalid]}
              keyboardType="phone-pad"
              textContentType="telephoneNumber"
              autoFocus
              placeholder="090 1234 5678"
              placeholderTextColor={COLORS.muted}
              value={phone}
              onChangeText={setPhone}
            />
            <AppText style={styles.hint}>
              Numbers without a country code are treated as Japanese (+{DEFAULT_COUNTRY_CODE}).
            </AppText>

            {error && <AppText style={styles.error}>{error}</AppText>}

            {/* "Continue", never "Sign up" or "Log in" — the label must not
                reveal whether this number already has an account. */}
            <Button
              label={busy ? "Sending…" : "Continue"}
              onPress={submitPhone}
              disabled={busy || !parsedPhone.ok}
              style={styles.primaryButton}
            />

            {onSkip && <Button label="Continue as guest" onPress={onSkip} variant="secondary" style={styles.secondaryButton} />}

            {/* No claim here that guest activity carries over into a real
                account, because it does not — see apps/web's identical note. */}
            <AppText style={styles.fineprint}>
              Your number is used to verify this account and is never shown to anyone else.
              {onSkip && " Guest activity stays on the guest account and doesn't move over when you sign in."}
            </AppText>
          </View>
        )}

        {step === "code" && (
          <View>
            <Button
              label="← Change number"
              variant="secondary"
              onPress={() => {
                setStep("phone");
                setError(null);
              }}
              style={styles.backButton}
            />
            <AppText style={styles.heading}>Enter your code</AppText>
            <AppText style={styles.lede}>
              We sent {OTP_LENGTH} digits to{" "}
              <AppText style={styles.strong}>{parsedPhone.ok ? parsedPhone.phone.e164 : phone}</AppText>.
            </AppText>

            <AppText style={styles.fieldLabel}>Verification code</AppText>
            <TextInput
              style={[styles.input, styles.codeInput]}
              keyboardType="number-pad"
              textContentType="oneTimeCode"
              autoFocus
              maxLength={OTP_LENGTH}
              placeholder="123456"
              placeholderTextColor={COLORS.muted}
              value={code}
              onChangeText={(text) => setCode(text.replace(/\s/g, ""))}
            />

            {error && <AppText style={styles.error}>{error}</AppText>}

            <Button
              label={busy ? "Checking…" : "Verify"}
              onPress={submitCode}
              disabled={busy || !isWellFormedOtp(code)}
              style={styles.primaryButton}
            />

            <Button
              label={cooldown > 0 ? `Resend in ${cooldown}s` : "Send a new code"}
              onPress={resend}
              disabled={busy || cooldown > 0}
              variant="secondary"
              style={styles.secondaryButton}
            />
          </View>
        )}

        {step === "handle" && <HandleStep onDone={onAuthenticated} />}
      </View>
    </KeyboardAvoidingView>
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
    const timer = setTimeout(async () => {
      const result = await isHandleAvailable(parsed.handle);
      if (seq === checkSeq.current) setAvailable(result);
    }, 400);
    return () => clearTimeout(timer);
  }, [parsed]);

  async function submit() {
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
    <View>
      <AppText style={styles.heading}>Pick your name</AppText>
      <AppText style={styles.lede}>
        Your username is how people find and mention you. Your display name is what they see.
      </AppText>

      <AppText style={styles.fieldLabel}>Display name</AppText>
      <TextInput
        style={styles.input}
        textContentType="name"
        autoFocus
        maxLength={40}
        placeholder="Your name"
        placeholderTextColor={COLORS.muted}
        value={name}
        onChangeText={setName}
      />

      <AppText style={styles.fieldLabel}>Username</AppText>
      <TextInput
        style={[styles.input, handleProblem !== null && styles.inputInvalid]}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        maxLength={20}
        placeholder="yourname"
        placeholderTextColor={COLORS.muted}
        value={handle}
        onChangeText={setHandle}
      />

      {handleProblem ? (
        <AppText style={styles.hintBad}>{handleProblem}</AppText>
      ) : available === false ? (
        <AppText style={styles.hintBad}>That username is taken.</AppText>
      ) : available === true ? (
        <AppText style={styles.hintOk}>@{parsed.ok ? parsed.handle : ""} is available.</AppText>
      ) : (
        <AppText style={styles.hint}>3–20 characters: a–z, 0–9 and underscore.</AppText>
      )}

      {error && <AppText style={styles.error}>{error}</AppText>}

      <Button
        label={busy ? "Saving…" : "Finish"}
        onPress={submit}
        disabled={busy || !parsed.ok || name.trim().length === 0 || available === false}
        style={styles.primaryButton}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, backgroundColor: COLORS.surface },
  card: { width: "100%", maxWidth: 400, backgroundColor: COLORS.glass, borderRadius: 20, padding: 24 },
  kicker: { color: COLORS.muted, fontSize: 14 },
  title: { fontSize: 32, fontWeight: "800", color: COLORS.teal, marginBottom: 12 },
  heading: { fontSize: 22, fontWeight: "700", marginBottom: 8 },
  lede: { color: COLORS.muted, marginBottom: 20, lineHeight: 20 },
  strong: { fontWeight: "700", color: COLORS.ink },
  fieldLabel: { fontSize: 13, fontWeight: "600", marginBottom: 6, marginTop: 4 },
  input: {
    borderWidth: 1,
    borderColor: COLORS.line,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    fontSize: 16,
    color: COLORS.ink,
    marginBottom: 8,
  },
  inputInvalid: { borderColor: COLORS.hot },
  codeInput: { fontSize: 24, letterSpacing: 4, textAlign: "center" },
  hint: { fontSize: 12, color: COLORS.muted, marginBottom: 16 },
  hintBad: { fontSize: 12, color: COLORS.hot, marginBottom: 16 },
  hintOk: { fontSize: 12, color: COLORS.teal, marginBottom: 16 },
  error: { fontSize: 13, color: COLORS.hot, marginBottom: 12 },
  fineprint: { fontSize: 11, color: COLORS.muted, marginTop: 16, lineHeight: 16 },
  primaryButton: { marginTop: 8 },
  secondaryButton: { marginTop: 10 },
  backButton: { alignSelf: "flex-start", marginBottom: 16, paddingHorizontal: 12, paddingVertical: 8 },
});
