import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  conversationSubtitle,
  conversationTitle,
  describeThreadEvent,
  groupTitleFromMembers,
  roomPreview,
  threadPreview,
} from '../src/domain/conversation.js';
import type {
  ChatMessage,
  DmEventKind,
  DmMessage,
  DmThread,
  DmThreadMember,
} from '../src/domain/types.js';

const ME = 'me';

function member(id: string, displayName: string): DmThreadMember {
  return { id, handle: id, displayName, avatarPath: null, role: 'member', blocked: false };
}

function group(over: Partial<DmThread> = {}): DmThread {
  return {
    id: 't1',
    kind: 'group',
    title: null,
    photoPath: null,
    createdBy: ME,
    myRole: 'owner',
    otherId: null,
    otherHandle: null,
    otherName: null,
    otherAvatarPath: null,
    members: [],
    memberCount: 1,
    lastMessageAt: null,
    lastBody: null,
    lastHasImage: false,
    lastHasPost: false,
    lastMediaKind: 'image',
    lastSenderId: null,
    lastSenderName: null,
    lastEventKind: null,
    lastEventTargetName: null,
    lastEventText: null,
    unread: 0,
    ...over,
  };
}

function direct(over: Partial<DmThread> = {}): DmThread {
  return group({
    kind: 'direct',
    otherId: 'u2',
    otherHandle: 'ana',
    otherName: 'Ana',
    memberCount: 2,
    myRole: 'member',
    ...over,
  });
}

function event(kind: DmEventKind, over: Partial<DmMessage> = {}): DmMessage {
  return {
    id: 'm1',
    threadId: 't1',
    senderId: 'u2',
    senderHandle: 'ana',
    senderName: 'Ana',
    senderAvatarPath: null,
    body: '',
    createdAt: '2026-09-14T00:00:00Z',
    mine: false,
    replyTo: null,
    reactions: [],
    media: null,
    sharedPost: null,
    eventKind: kind,
    eventTargetId: null,
    eventTargetName: null,
    eventText: null,
    ...over,
  };
}

describe('groupTitleFromMembers', () => {
  it('names a group of three from both other members', () => {
    assert.equal(groupTitleFromMembers([member('a', 'Ana'), member('b', 'Bo')], 2), 'Ana & Bo');
  });

  it('uses commas before the ampersand once there are three others', () => {
    assert.equal(
      groupTitleFromMembers([member('a', 'Ana'), member('b', 'Bo'), member('c', 'Chi')], 3),
      'Ana, Bo & Chi',
    );
  });

  // The whole reason this function takes a count instead of reading
  // members.length: the inbox carries at most four members per row.
  it('counts the members the inbox did not carry', () => {
    const four = [member('a', 'Ana'), member('b', 'Bo'), member('c', 'Chi'), member('d', 'Dee')];
    assert.equal(groupTitleFromMembers(four, 9), 'Ana, Bo, Chi, Dee & 5 others');
  });

  it('says "other", singular, when exactly one is hidden', () => {
    assert.equal(groupTitleFromMembers([member('a', 'Ana')], 2), 'Ana & 1 other');
  });

  it('does not produce a negative remainder from a stale count', () => {
    assert.equal(groupTitleFromMembers([member('a', 'Ana'), member('b', 'Bo')], 1), 'Ana & Bo');
  });

  it('falls back to a word rather than an empty title bar', () => {
    assert.equal(groupTitleFromMembers([], 0), 'Group');
    assert.equal(groupTitleFromMembers([member('a', '   ')], 1), 'Group');
  });
});

describe('conversationTitle', () => {
  it('is the other person, for a direct thread', () => {
    assert.equal(conversationTitle(direct()), 'Ana');
  });

  it('prefers a group name over the generated one', () => {
    assert.equal(
      conversationTitle(group({ title: 'Tuesday Football', members: [member('a', 'Ana')], memberCount: 3 })),
      'Tuesday Football',
    );
  });

  it('generates one when the group has no name', () => {
    assert.equal(
      conversationTitle(group({ members: [member('a', 'Ana'), member('b', 'Bo')], memberCount: 3 })),
      'Ana & Bo',
    );
  });

  // A title that is entirely spaces is a title nobody can see, so it is
  // treated as no title rather than rendered as a blank header.
  it('treats a whitespace-only name as unnamed', () => {
    assert.equal(
      conversationTitle(group({ title: '   ', members: [member('a', 'Ana')], memberCount: 2 })),
      'Ana',
    );
  });
});

describe('conversationSubtitle', () => {
  it('is the handle on a direct thread', () => {
    assert.equal(conversationSubtitle(direct()), '@ana');
  });

  it('is a headcount on a group, and counts the viewer', () => {
    assert.equal(conversationSubtitle(group({ memberCount: 4 })), '4 members');
    assert.equal(conversationSubtitle(group({ memberCount: 1 })), '1 member');
  });

  it('is null rather than an empty line when there is nothing to say', () => {
    assert.equal(conversationSubtitle(direct({ otherHandle: null })), null);
  });
});

describe('describeThreadEvent', () => {
  it('writes in the second person when it was you', () => {
    assert.equal(
      describeThreadEvent(event('added', { senderId: ME, eventTargetName: 'Sam' }), ME),
      'You added Sam',
    );
  });

  it('names the actor when it was someone else', () => {
    assert.equal(describeThreadEvent(event('added', { eventTargetName: 'Sam' }), ME), 'Ana added Sam');
  });

  it('covers leaving, removal and creation', () => {
    assert.equal(describeThreadEvent(event('left'), ME), 'Ana left');
    assert.equal(
      describeThreadEvent(event('removed', { eventTargetName: 'Sam' }), ME),
      'Ana removed Sam',
    );
    assert.equal(describeThreadEvent(event('created'), ME), 'Ana created the group');
    assert.equal(describeThreadEvent(event('photo'), ME), 'Ana changed the group photo');
  });

  // The name comes from the event row rather than from the thread, so a
  // history of renames reads correctly instead of every entry showing the
  // newest name.
  it('quotes the name the rename actually set', () => {
    assert.equal(
      describeThreadEvent(event('renamed', { eventText: 'Tuesday Football' }), ME),
      'Ana named the group “Tuesday Football”',
    );
  });

  it('reads as a removal when the rename cleared the name', () => {
    assert.equal(describeThreadEvent(event('renamed'), ME), 'Ana removed the group name');
  });

  it('survives a profile deleted after the event was recorded', () => {
    assert.equal(
      describeThreadEvent(event('added', { senderName: '', eventTargetName: null }), ME),
      'Someone added someone',
    );
  });

  it('is null for an ordinary message, which is what tells a bubble from an event', () => {
    assert.equal(describeThreadEvent({ ...event('added'), eventKind: null }, ME), null);
  });
});

describe('threadPreview', () => {
  it('prefixes your own messages with "You:" on either kind', () => {
    assert.equal(
      threadPreview(direct({ lastBody: 'on my way', lastSenderId: ME }), ME),
      'You: on my way',
    );
  });

  // A direct row is already titled with that person's name, so repeating it in
  // the preview would say it twice on one line.
  it('does not name the sender on a direct thread', () => {
    assert.equal(threadPreview(direct({ lastBody: 'on my way', lastSenderId: 'u2' }), ME), 'on my way');
  });

  it('names the sender on a group, where the title does not', () => {
    assert.equal(
      threadPreview(
        group({ lastBody: 'on my way', lastSenderId: 'u2', lastSenderName: 'Ana' }),
        ME,
      ),
      'Ana: on my way',
    );
  });

  it('describes an attachment that came with no caption', () => {
    assert.equal(threadPreview(direct({ lastHasImage: true, lastSenderId: 'u2' }), ME), 'Photo');
    assert.equal(
      threadPreview(direct({ lastHasImage: true, lastMediaKind: 'video', lastSenderId: 'u2' }), ME),
      'Video',
    );
    assert.equal(threadPreview(direct({ lastHasPost: true, lastSenderId: 'u2' }), ME), 'Shared a pin');
  });

  it('renders a system event rather than a blank row', () => {
    assert.equal(
      threadPreview(
        group({ lastEventKind: 'added', lastSenderName: 'Ana', lastEventTargetName: 'Sam' }),
        ME,
      ),
      'Ana added Sam',
    );
  });

  it('is null on a conversation nobody has written in, so the caller can say so itself', () => {
    assert.equal(threadPreview(group(), ME), null);
  });
});

function roomMessage(over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'c1',
    body: 'on my way',
    createdAt: '2026-09-14T00:00:00Z',
    authorId: 'u2',
    authorHandle: 'ana',
    authorName: 'Ana Ruiz',
    authorAvatarPath: null,
    mine: false,
    replyTo: null,
    reactions: [],
    media: null,
    sharedPost: null,
    seenBy: 0,
    ...over,
  };
}

describe('roomPreview', () => {
  it('is null before anyone has spoken, so the caller can say something else', () => {
    assert.equal(roomPreview(null, ME), null);
  });

  // Unlike a direct thread, which is titled with the other person's name
  // already — the room's row is titled "Everyone", so the name is the part
  // that carries.
  it('always names the speaker', () => {
    assert.equal(roomPreview(roomMessage(), ME), 'Ana Ruiz: on my way');
  });

  it('writes your own in the second person', () => {
    assert.equal(roomPreview(roomMessage({ authorId: ME }), ME), 'You: on my way');
  });

  it('describes an attachment that came with no caption', () => {
    const media = { kind: 'image' as const, path: 'k', width: 10, height: 10, posterPath: null, durationMs: null };
    assert.equal(roomPreview(roomMessage({ body: '', media }), ME), 'Ana Ruiz: Photo');
    assert.equal(
      roomPreview(roomMessage({ body: '', media: { ...media, kind: 'video', posterPath: 'p' } }), ME),
      'Ana Ruiz: Video',
    );
  });

  it('falls back to a word for a name that is missing', () => {
    assert.equal(roomPreview(roomMessage({ authorName: '  ' }), ME), 'Someone: on my way');
  });

  it('is null for a message carrying nothing it can describe', () => {
    assert.equal(roomPreview(roomMessage({ body: '' }), ME), null);
  });
});
