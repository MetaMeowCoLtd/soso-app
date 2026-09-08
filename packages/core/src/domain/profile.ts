/**
 * Editing your own profile: what a display name and a bio are allowed to be.
 *
 * Pure and I/O-free, like the rest of this folder, so the rules are tested
 * directly rather than only discovered when the database rejects a write.
 * The limits here MIRROR the constraints the schema enforces — display name
 * 1–40 (the CHECK on `profiles.display_name` since migration 0003), bio
 * 0–160 (the CHECK added in migration 0033) — and must not drift from them,
 * or the UI accepts something the database then refuses with a raw
 * constraint error the person cannot act on.
 *
 * WHY BIO IS ALLOWED TO BE EMPTY BUT NAME IS NOT
 * ---------------------------------------------------------------------
 * A display name is how you appear in every list and byline; blank there is
 * not a valid state, it is a broken row. A bio is optional by nature —
 * "no bio" is a normal, common choice, not a mistake — so an empty bio is
 * accepted and stored as the empty string rather than rejected.
 */

export const DISPLAY_NAME_MAX = 40;
export const BIO_MAX = 160;

export type DisplayNameProblem = "empty" | "too_long";
export type BioProblem = "too_long";

export type DisplayNameResult =
  | { ok: true; value: string }
  | { ok: false; problem: DisplayNameProblem };

export type BioResult = { ok: true; value: string } | { ok: false; problem: BioProblem };

/**
 * Trims first, then judges. Leading/trailing whitespace is presentation,
 * not content: a name that is all spaces is empty, and " Michal " and
 * "Michal" are the same name. Counting the untrimmed length would let a
 * row of spaces pass the "not empty" check and then fail the database's
 * own trimmed expectations, or eat into the 40 a real name is entitled to.
 */
export function validateDisplayName(input: string): DisplayNameResult {
  const value = input.trim();
  if (value.length === 0) return { ok: false, problem: "empty" };
  if (value.length > DISPLAY_NAME_MAX) return { ok: false, problem: "too_long" };
  return { ok: true, value };
}

/**
 * A bio keeps its internal newlines and spacing — that shaping is content a
 * person chose — but is trimmed at the ends, where trailing blank lines are
 * just accidental Enter presses, and is measured AFTER trimming so those
 * accidents don't count against the limit.
 */
export function validateBio(input: string): BioResult {
  const value = input.trim();
  if (value.length > BIO_MAX) return { ok: false, problem: "too_long" };
  return { ok: true, value };
}

/** Characters remaining, never negative past the cap — for a live counter under the field. */
export function bioRemaining(input: string): number {
  return BIO_MAX - input.trim().length;
}
