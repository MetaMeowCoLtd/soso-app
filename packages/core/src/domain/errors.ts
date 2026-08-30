/**
 * Error codes.
 *
 * The database raises these as the exception message so the client can branch
 * on a stable string instead of parsing English prose. Mirrors `soso.fail`
 * call sites in migration 0005.
 */

export const SOSO_ERROR_CODES = [
  'soso/unauthenticated',
  'soso/no_profile',
  'soso/banned',
  'soso/category_unavailable',
  'soso/reputation_too_low',
  'soso/invalid_subtype',
  'soso/body_not_allowed',
  'soso/body_too_long',
  'soso/rate_limited',
  'soso/invalid_location',
  'soso/device_location_required',
  'soso/too_far_away',
  'soso/no_cells',
  'soso/too_many_cells',
  'soso/invalid_vote',
  'soso/post_unavailable',
  'soso/cannot_vote_own',
  'soso/push_not_configured',
  'soso/push_subscription_invalid',
] as const;

export type SosoErrorCode = (typeof SOSO_ERROR_CODES)[number];

const CODE_SET: ReadonlySet<string> = new Set(SOSO_ERROR_CODES);

export class SosoError extends Error {
  readonly code: SosoErrorCode | 'soso/unknown';

  constructor(code: SosoErrorCode | 'soso/unknown', cause?: unknown) {
    super(code);
    this.name = 'SosoError';
    this.code = code;
    this.cause = cause;
  }
}

/**
 * Turn whatever the Supabase client threw into a `SosoError`.
 *
 * Anything we do not recognise becomes `soso/unknown` rather than being
 * swallowed: an unrecognised failure is a bug to surface, not a state to
 * silently absorb.
 */
export function toSosoError(err: unknown): SosoError {
  const message =
    typeof err === 'object' && err !== null && 'message' in err
      ? String((err as { message: unknown }).message)
      : String(err);

  return CODE_SET.has(message)
    ? new SosoError(message as SosoErrorCode, err)
    : new SosoError('soso/unknown', err);
}

/** User-facing text. Deliberately kept apart from the codes themselves. */
export const ERROR_MESSAGES_EN: Record<SosoErrorCode | 'soso/unknown', string> = {
  'soso/unauthenticated': 'Sign in to post.',
  'soso/no_profile': 'Your account is still being set up. Try again shortly.',
  'soso/banned': 'Your account cannot post at the moment.',
  'soso/category_unavailable': 'That kind of post is not available right now.',
  'soso/reputation_too_low': 'You need a bit more activity before posting this.',
  'soso/invalid_subtype': 'Pick a valid type.',
  'soso/body_not_allowed': 'This kind of post does not take a description.',
  'soso/body_too_long': 'That description is too long.',
  'soso/rate_limited': 'You have posted a lot recently. Try again later.',
  'soso/invalid_location': 'That location does not look right.',
  'soso/device_location_required': 'Turn on location to post this.',
  'soso/too_far_away': 'You need to be at the place to post this.',
  'soso/no_cells': 'No map area selected.',
  'soso/too_many_cells': 'Zoom in to load reports.',
  'soso/invalid_vote': 'Invalid response.',
  'soso/post_unavailable': 'That post is no longer available.',
  'soso/cannot_vote_own': 'You cannot confirm your own post.',
  'soso/push_not_configured': 'Notifications are not configured for this project yet.',
  'soso/push_subscription_invalid': 'This browser gave Soso an invalid notification subscription. Try enabling alerts again.',
  'soso/unknown': 'Something went wrong. Try again.',
};
