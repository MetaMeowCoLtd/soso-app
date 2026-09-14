/**
 * What a conversation is called, and what its system rows say.
 *
 * Both questions look like presentation and are not. A group's name is absent
 * far more often than it is present — Instagram, LINE and iMessage all let you
 * start one without naming it, and most people never do — so "what goes in the
 * title bar" is a real computation over the member list, run on at least four
 * surfaces (the inbox row, the thread header, the group detail sheet, and a
 * notification). The same goes for "Ana added Sam": the database deliberately
 * stores the event and not the sentence (see migration 0047), so the sentence
 * has to be built somewhere, once.
 *
 * Here rather than in a component, because every one of these is a pure
 * function of data the server already sent, they are shared by the web app and
 * by anything else that implements `SosoGateway`, and the rules are fiddly
 * enough to be worth testing directly: the "& 2 others" arithmetic has an
 * off-by-one in it that is invisible in a component and obvious in a test.
 */

import type { DmMessage, DmThread, DmThreadMember } from './types';

/**
 * The most people a conversation may hold, counting yourself.
 *
 * Matches `create_group_thread` and `add_group_members`, which enforce it —
 * this is the copy the UI disables a button with, not the copy that decides.
 * Instagram's number, for no better reason than that it is large enough that
 * nobody in a group of friends hits it and small enough that a group cannot
 * become a broadcast channel.
 */
export const GROUP_MAX_MEMBERS = 32;

/**
 * How many OTHER people it takes to make a group rather than a DM.
 *
 * Two, and the reason is worth keeping in front of whoever changes it:
 * selecting one friend means "message this person", and answering it with a
 * two-person group would leave that pair with two separate conversations,
 * two unread badges and no way to tell them apart in the inbox. The picker
 * opens the DM instead — see `NewGroupSheet` — and the server refuses the
 * case outright so that a client which forgets cannot create the mess.
 */
export const GROUP_MIN_OTHERS = 2;

/** Characters, matching `dm_threads_title_shape`. */
export const GROUP_TITLE_MAX = 60;

/**
 * The name of an unnamed group, built from who is in it.
 *
 * `othersCount` is the number of members other than you, which is NOT
 * `members.length`: the inbox carries at most four of them (see
 * `soso.dm_members_json`) precisely so that a 20-person group's row does not
 * ship 20 profiles to render one line of text. The hidden remainder becomes
 * "& 14 others".
 *
 * Returns a fallback rather than an empty string when there is nobody to name.
 * That happens for a moment in exactly one real case — a group whose other
 * members have all deleted their accounts — and an empty title bar reads as a
 * rendering bug where a word does not.
 */
export function groupTitleFromMembers(
  members: readonly DmThreadMember[],
  othersCount: number,
): string {
  const names = members.map((m) => m.displayName.trim()).filter((n) => n.length > 0);
  if (names.length === 0) return 'Group';

  // Never negative: a stale `memberCount` smaller than the list it came with
  // would otherwise produce "& -1 others".
  const hidden = Math.max(0, othersCount - names.length);

  if (hidden === 0) {
    if (names.length === 1) return names[0]!;
    // "Ana, Bo & Chi" — an ampersand before the last, commas before the rest.
    return `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]!}`;
  }

  return `${names.join(', ')} & ${hidden} ${hidden === 1 ? 'other' : 'others'}`;
}

/**
 * What to show as the conversation's name, for either kind.
 *
 * The one place that branches on `kind` for a label. Every surface that needs
 * a title calls this instead of asking whether the thread is a group, which is
 * what keeps the four of them agreeing.
 */
export function conversationTitle(thread: DmThread): string {
  if (thread.kind === 'direct') {
    // A direct thread whose other side has no name should still say
    // something, for the same reason `groupTitleFromMembers` has a fallback.
    return thread.otherName?.trim() || 'Someone';
  }
  return thread.title?.trim() || groupTitleFromMembers(thread.members, thread.memberCount - 1);
}

/**
 * The line under the title: a handle for a person, a headcount for a group.
 *
 * Null where there is nothing useful to say, so a caller can leave the slot
 * out entirely rather than render an empty element with its own margins.
 */
export function conversationSubtitle(thread: DmThread): string | null {
  if (thread.kind === 'direct') {
    return thread.otherHandle ? `@${thread.otherHandle}` : null;
  }
  return `${thread.memberCount} ${thread.memberCount === 1 ? 'member' : 'members'}`;
}

/**
 * The sentence for a system row — "You added Sam", "Ana left".
 *
 * SECOND PERSON WHEN IT IS YOU, and that is the whole reason this takes the
 * signed-in user's id rather than composing from names alone: "Ana added Sam"
 * reads as somebody else's activity even when Ana is you, and every chat app
 * worth copying writes "You added Sam".
 *
 * Falls back to a name-free phrasing when a name is missing rather than
 * printing an empty gap, which happens when a profile is deleted after the
 * event was recorded (`event_target_id` is ON DELETE SET NULL).
 */
export function describeThreadEvent(message: DmMessage, myId: string): string | null {
  if (!message.eventKind) return null;

  return threadEventSentence(
    message.eventKind,
    message.senderId === myId ? 'You' : message.senderName.trim() || 'Someone',
    message.eventTargetName?.trim() || 'someone',
    // The name comes from the row, not from the thread's current title — see
    // the `event_text` column's own comment on why a history composed from the
    // live title rewrites itself on every later rename.
    message.eventText,
  );
}

/**
 * The inbox's one-line preview of whatever happened last.
 *
 * Separate from `describeThreadEvent` because the inbox has a thread and not a
 * message — it never loaded the conversation — so it works from the handful of
 * `last*` fields the thread row carries instead. The two produce the same
 * sentences from different inputs, which is why the phrasing lives in
 * `threadEventSentence` below and both call it.
 */
export function threadPreview(thread: DmThread, myId: string | null): string | null {
  if (thread.lastEventKind) {
    return threadEventSentence(
      thread.lastEventKind,
      thread.lastSenderId === myId ? 'You' : thread.lastSenderName?.trim() || 'Someone',
      thread.lastEventTargetName?.trim() || 'someone',
      thread.lastEventText,
    );
  }

  const body =
    thread.lastBody ||
    (thread.lastHasImage
      ? thread.lastMediaKind === 'video'
        ? 'Video'
        : 'Photo'
      : thread.lastHasPost
        ? 'Shared a pin'
        : null);

  if (body === null) return null;

  // A group says who spoke; a direct thread does not need to, because the row
  // is already titled with that person's name.
  if (thread.lastSenderId === myId) return `You: ${body}`;
  if (thread.kind === 'group' && thread.lastSenderName) {
    return `${thread.lastSenderName}: ${body}`;
  }
  return body;
}

/** The shared phrasing behind `describeThreadEvent` and `threadPreview`. */
function threadEventSentence(
  kind: NonNullable<DmMessage['eventKind']>,
  actor: string,
  target: string,
  text: string | null,
): string {
  switch (kind) {
    case 'created':
      return `${actor} created the group`;
    case 'added':
      return `${actor} added ${target}`;
    case 'removed':
      return `${actor} removed ${target}`;
    case 'left':
      return `${actor} left`;
    case 'renamed':
      return text ? `${actor} named the group “${text}”` : `${actor} removed the group name`;
    case 'photo':
      return `${actor} changed the group photo`;
  }
}
