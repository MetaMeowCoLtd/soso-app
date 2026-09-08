/**
 * Phone numbers: normalising them, checking them, and showing them safely.
 *
 * Pure and I/O-free on purpose, the same as every other module in this
 * folder — which is what lets the rules below be tested directly rather
 * than only exercised through a live SMS provider that this project has no
 * way to call from a test.
 *
 * WHY E.164 IS THE ONLY STORED FORM
 * ---------------------------------------------------------------------
 * `+819012345678` and `090-1234-5678` and `+81 90 1234 5678` are one
 * number wearing three coats. If any of those can reach the database as
 * written, then "have we already sent a code to this number in the last
 * minute" quietly becomes false for two of them, and the per-number
 * throttle in migration 0031 — the thing standing between this app and a
 * toll-fraud bill — stops meaning anything. So normalisation happens once,
 * here, before the number is used as a key for anything at all.
 *
 * WHAT THIS DELIBERATELY IS NOT
 * ---------------------------------------------------------------------
 * Not libphonenumber. That library knows every carrier prefix and
 * numbering plan on earth, and it costs ~300KB to know them. This validates
 * the shape E.164 actually specifies — a leading `+`, a nonzero leading
 * digit, 8 to 15 digits total — and leaves "is this a real, reachable
 * subscriber line" to the one component that can genuinely answer it: the
 * SMS provider, which finds out by trying. A number that passes here and
 * doesn't exist fails at send time, which is a state the UI has to handle
 * regardless of how clever the client-side check is.
 *
 * The consequence worth being explicit about: this accepts numbers that
 * are well-formed but unassigned. That is the correct tradeoff for a
 * client-side check, because the alternative — rejecting real numbers in
 * regions whose numbering plan the bundled table is out of date about — is
 * a user who simply cannot sign up and cannot tell you why.
 */

/**
 * E.164 caps the whole number at 15 digits; the shortest real ones in
 * active use run to 8 including the country code. A leading zero is
 * invalid in E.164 — country codes never start with one, and trunk
 * prefixes (Japan's leading `0`, the UK's) are exactly what the `+` form
 * exists to strip.
 */
const E164 = /^\+[1-9]\d{7,14}$/;

/** Digits, and the separators people actually type between them. */
const ALLOWED_INPUT = /^[+０-９\d\s\-().]+$/;

/**
 * Full-width digits are what a Japanese IME produces by default in a
 * numeric field, so a Tokyo-facing app that rejects them is rejecting its
 * own users for using their keyboard as shipped.
 */
function foldFullWidthDigits(value: string): string {
  return value.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
}

export interface NormalizedPhone {
  /** Strict E.164, the only form anything downstream should ever store or compare. */
  e164: string;
}

export type PhoneProblem =
  | 'empty'
  | 'bad_characters'
  | 'no_country_code'
  | 'too_short'
  | 'too_long'
  | 'malformed';

export type PhoneResult =
  | { ok: true; phone: NormalizedPhone }
  | { ok: false; problem: PhoneProblem };

/**
 * Normalises typed input to E.164, or explains what's wrong with it.
 *
 * `defaultCountryCode` (e.g. `'81'`) lets someone type their number the
 * local way — `090-1234-5678` — without having to know what E.164 is. The
 * single leading `0` is a national trunk prefix and is dropped when the
 * country code is applied, which is the rule for Japan and for every other
 * plan that uses one. A number typed WITH a `+` ignores the default
 * entirely, because at that point the user has been explicit and guessing
 * over the top of them would be wrong.
 */
export function normalizePhone(input: string, defaultCountryCode?: string): PhoneResult {
  const raw = foldFullWidthDigits(input).trim();
  if (raw.length === 0) return { ok: false, problem: 'empty' };
  if (!ALLOWED_INPUT.test(raw)) return { ok: false, problem: 'bad_characters' };

  // Everything that isn't a digit or the leading + is presentation: spaces,
  // hyphens, and the parenthesised area codes common in North America.
  const hasPlus = raw.startsWith('+');
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 0) return { ok: false, problem: 'malformed' };

  let e164: string;
  if (hasPlus) {
    e164 = `+${digits}`;
  } else if (defaultCountryCode) {
    const cc = defaultCountryCode.replace(/\D/g, '');
    if (cc.length === 0) return { ok: false, problem: 'no_country_code' };
    // One leading trunk zero, and only one: `0090…` is a typo, not a
    // number with two trunk prefixes, and silently repairing it would
    // produce a valid-looking number that belongs to someone else.
    const national = digits.startsWith('0') ? digits.slice(1) : digits;
    e164 = `+${cc}${national}`;
  } else {
    return { ok: false, problem: 'no_country_code' };
  }

  if (E164.test(e164)) return { ok: true, phone: { e164 } };

  // Past this point it's malformed; say HOW so the UI can be specific
  // rather than showing one catch-all message for every kind of mistake.
  const bodyLength = e164.length - 1;
  if (bodyLength < 8) return { ok: false, problem: 'too_short' };
  if (bodyLength > 15) return { ok: false, problem: 'too_long' };
  return { ok: false, problem: 'malformed' };
}

/**
 * The number with everything but the last two digits replaced, for showing
 * someone which of their numbers a code went to without putting the number
 * itself on a screen that might be over their shoulder, in a screenshot, or
 * in a support ticket.
 *
 * The country code stays visible because it is not the secret part and it
 * is the half that makes the number recognisable to its owner at a glance.
 * Two trailing digits is the amount Instagram, Google and bank confirmation
 * screens all settle on — enough to tell your own numbers apart from each
 * other, not enough to be worth harvesting.
 */
export function maskPhone(e164: string): string {
  if (!E164.test(e164)) return '•••';
  const cc = e164.slice(0, e164.length - 9) || e164.slice(0, 3);
  const tail = e164.slice(-2);
  return `${cc} •••• ${tail}`;
}

/**
 * How long to refuse another send after one just went out.
 *
 * Grows with each attempt rather than staying flat, because a flat cooldown
 * is only an inconvenience to someone burning SMS credit in a loop: they
 * pay it once per message and keep going. Doubling means the tenth message
 * costs an attacker minutes rather than seconds, while a real person
 * retrying once or twice barely notices the difference between 30 and 60
 * seconds. Capped so a legitimate user who has genuinely mistyped their
 * number several times is never locked out for an absurd stretch.
 *
 * This is the client's own copy of the rule, for showing an honest
 * countdown. It is NOT the enforcement — that lives in the database (see
 * `soso.check_otp_throttle` in migration 0031), because a limit that only
 * exists in the client is a limit that only applies to people using the
 * client.
 */
export function resendCooldownSeconds(previousSends: number): number {
  if (previousSends <= 0) return 0;
  const seconds = 30 * 2 ** (previousSends - 1);
  return Math.min(seconds, 15 * 60);
}

/** Codes are fixed-length numeric; anything else can be rejected without a round trip. */
export const OTP_LENGTH = 6;

/**
 * The code as it must be SENT: full-width digits folded to ASCII and
 * surrounding whitespace removed.
 *
 * This has to exist separately from `isWellFormedOtp` and be used at the
 * point of submission, not just validation. `isWellFormedOtp` folds
 * full-width digits before testing, so a Japanese IME's `４２４２４２`
 * passes the check and enables the Verify button — but if the raw,
 * unfolded string is then what gets sent, the provider sees characters
 * that are not ASCII digits and rejects a code the user typed correctly.
 * Validating the folded form while transmitting the unfolded one is how
 * you build full-width support that silently fails exactly the users it
 * was for.
 */
export function normalizeOtp(code: string): string {
  return foldFullWidthDigits(code).trim();
}

export function isWellFormedOtp(code: string): boolean {
  return new RegExp(`^\\d{${OTP_LENGTH}}$`).test(normalizeOtp(code));
}

/**
 * Handles are the public identifier — the `mhw3717` under the display
 * name. Mirrors the CHECK constraint on `profiles.handle` exactly
 * (migration 0003: `^[a-z0-9_]{3,20}$`); the two must not drift, or the UI
 * accepts something the database then rejects with a constraint error the
 * user cannot act on.
 */
const HANDLE = /^[a-z0-9_]{3,20}$/;

/**
 * Names that must not be claimable, because a handle is shown next to
 * content and these carry authority the holder wouldn't have. This is the
 * client-side copy for instant feedback; migration 0031 enforces the same
 * list, since a check that only runs in the browser is decoration.
 */
const RESERVED_HANDLES = new Set([
  'soso',
  'admin',
  'administrator',
  'root',
  'system',
  'support',
  'help',
  'staff',
  'moderator',
  'mod',
  'official',
  'security',
  'about',
  'settings',
  'login',
  'signup',
  'me',
  'you',
  'null',
  'undefined',
  'anonymous',
]);

export type HandleProblem = 'empty' | 'too_short' | 'too_long' | 'bad_characters' | 'reserved';

export type HandleResult = { ok: true; handle: string } | { ok: false; problem: HandleProblem };

/**
 * Case is folded rather than rejected: someone typing `Michal` means the
 * same handle as `michal`, and the database column only accepts lowercase.
 * Uppercase input is a keyboard state, not an intent to pick a different
 * name.
 */
export function normalizeHandle(input: string): HandleResult {
  const handle = input.trim().toLowerCase();
  if (handle.length === 0) return { ok: false, problem: 'empty' };
  if (handle.length < 3) return { ok: false, problem: 'too_short' };
  if (handle.length > 20) return { ok: false, problem: 'too_long' };
  if (!HANDLE.test(handle)) return { ok: false, problem: 'bad_characters' };
  if (RESERVED_HANDLES.has(handle)) return { ok: false, problem: 'reserved' };
  return { ok: true, handle };
}

export function isReservedHandle(handle: string): boolean {
  return RESERVED_HANDLES.has(handle.trim().toLowerCase());
}
