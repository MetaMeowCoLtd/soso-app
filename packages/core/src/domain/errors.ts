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
  'soso/user_not_found',
  'soso/cannot_follow_self',
  'soso/cannot_block_self',
  'soso/not_friends',
  'soso/no_recipients',
  'soso/too_many_recipients',
  'soso/too_many_zones',
  'soso/invalid_zone_audience',
  'soso/post_not_found',
  'soso/not_yours_or_already_gone',
  'soso/empty_message',
  'soso/message_too_long',
  'soso/insufficient_coins',
  'soso/invalid_walk_distance',
  'soso/implausible_walk',
  'soso/walk_rate_limited',
  'soso/invalid_tile',
  'soso/board_not_found',
  'soso/board_locked',
  'soso/board_tile_conflict',
  'soso/forbidden',
  'soso/bad_request',
  'soso/internal_error',
  'soso/r2_not_configured',
  'soso/reply_too_long',
  'soso/message_not_found',
  'soso/invalid_reaction',
  'soso/thread_not_found',
  'soso/invalid_key',
  'soso/no_key_yet',
  'soso/undecryptable',
  'soso/verification_required',
  'soso/unreachable',
  'soso/otp_rate_limited',
  'soso/otp_cooldown',
  'soso/invalid_handle',
  'soso/handle_taken',
  'soso/handle_reserved',
  'soso/handle_already_set',
  'soso/invalid_display_name',
  'soso/bio_too_long',
  'soso/invalid_avatar_path',
  'soso/invalid_avatar_image',
  'soso/avatar_upload_failed',
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
  'soso/user_not_found': 'No user with that handle.',
  'soso/cannot_follow_self': "That's your own handle.",
  'soso/cannot_block_self': "You can't block yourself.",
  'soso/not_friends': 'You need to follow each other before you can do that.',
  'soso/no_recipients': 'Pick at least one person to share this with.',
  'soso/too_many_recipients': "That's too many people to share with at once.",
  'soso/too_many_zones': "You've reached the limit on saved areas.",
  'soso/invalid_zone_audience': 'Pick who this area is shared with.',
  'soso/post_not_found': 'That post is no longer available.',
  'soso/not_yours_or_already_gone': "That post isn't yours, or it's already gone.",
  'soso/empty_message': "Type something first.",
  'soso/message_too_long': "That's too long — keep it under 500 characters.",
  'soso/insufficient_coins': "You don't have enough coins to post this. Walk a bit to earn more.",
  'soso/invalid_walk_distance': "That walk doesn't look right.",
  'soso/implausible_walk': "That was too fast to count as a walk.",
  'soso/walk_rate_limited': "You've already logged a lot of walking recently. Try again later.",
  'soso/invalid_tile': "That tile position isn't valid.",
  'soso/board_not_found': "That board isn't available.",
  'soso/board_locked': 'A moderator has locked this board — no new strokes for now.',
  'soso/board_tile_conflict': 'Someone else just drew on that tile. Refresh it and try again.',
  'soso/forbidden': "You don't have access to that board.",
  'soso/bad_request': 'That request was malformed. Try again.',
  'soso/internal_error': 'Something went wrong on the server. Try again.',
  'soso/r2_not_configured': 'Drawing boards are not fully set up on this server yet.',
  'soso/reply_too_long': "That reply is too long — keep it under 500 characters.",
  'soso/message_not_found': "That message isn't there any more.",
  'soso/invalid_reaction': "That reaction didn't go through — try again.",
  'soso/thread_not_found': 'That conversation is no longer available.',
  'soso/invalid_key': "This browser's messaging key looks wrong. Reload and try again.",
  'soso/no_key_yet': "They haven't opened messages yet, so there's no key to encrypt to. Try again once they have.",
  'soso/undecryptable': "This message can't be read on this device.",
  'soso/verification_required': 'Verify your phone number to do that.',
  'soso/unreachable': "Couldn't reach SoSo. Check your connection and try again.",
  'soso/otp_rate_limited': 'Too many verification attempts. Try again later.',
  'soso/otp_cooldown': 'A code was just sent. Wait a moment before asking for another.',
  'soso/invalid_handle': 'Usernames are 3-20 characters, using a-z, 0-9 and underscore.',
  'soso/handle_taken': 'That username is taken.',
  'soso/handle_reserved': 'That username is not available.',
  'soso/handle_already_set': 'Your username has already been set.',
  'soso/invalid_display_name': 'Enter a name between 1 and 40 characters.',
  'soso/bio_too_long': 'That bio is too long (160 characters max).',
  // Not something a person can act on by choosing differently — a path is
  // built by the client, never typed — so this says what happened rather
  // than asking them to fix it.
  'soso/invalid_avatar_path': "That photo couldn't be saved. Try picking it again.",
  'soso/invalid_avatar_image': 'Pick a JPEG, PNG or WebP image under 12 MB.',
  'soso/avatar_upload_failed': "Couldn't upload that photo. Check your connection and try again.",
  'soso/unknown': 'Something went wrong. Try again.',
};
