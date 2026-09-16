import {
  describeThreadEvent,
  type AvatarPath,
  type ChatMessage,
  type DmMessage,
  type DmThread,
  type Mention,
  type MessageMedia,
  type SharedPost,
} from "../core";

/**
 * `ChatMessage` and `DmMessage` are two different shapes for the same idea
 * — see DmThreadView.tsx's own module comment: "this cost four branches
 * rather than a second file." Mobile takes that one step further: rather
 * than branching on which type a row is INSIDE the bubble component (what
 * ChatMessageRow/DmBubble each did on the web, twice, kept in sync only by
 * eyeballing both files), both are mapped once, here, into one shape —
 * `MessageBubble` and the run/divider logic in ConversationView then have
 * exactly one row shape to render, with no `"authorName" ?? "senderName"`
 * branching anywhere near the JSX.
 *
 * What's deliberately NOT normalized: read-receipt policy (a room's plain
 * count vs. a DM's per-reader map) and grouping policy (the room's time-gap
 * dividers vs. a DM's pure author-based runs) are real behavioural
 * differences between the two surfaces, not incidental type shape — see
 * ChatPanel's `receiptMessageId`/`GROUP_WINDOW_SECONDS` vs. DmThreadView's
 * `receiptsByMessage`/lack of any divider at all. Those stay computed by
 * each screen and passed into ConversationView as plain callbacks/config,
 * exactly mirroring where the web version keeps them.
 */
export interface NormalizedReply {
  id: string;
  authorLabel: string;
  body: string;
  media: MessageMedia | null;
  hasPost: boolean;
}

export interface NormalizedReaction {
  emoji: string;
  count: number;
  mine: boolean;
}

export interface NormalizedRow {
  id: string;
  /** An "event" row ("Ana added Sam") renders as a centred pill, not a bubble — see DmMessage.eventKind. */
  kind: "message" | "event";
  eventText: string | null;
  body: string;
  createdAt: string;
  mine: boolean;
  authorId: string;
  authorName: string;
  authorHandle: string;
  authorAvatarPath: AvatarPath;
  replyTo: NormalizedReply | null;
  reactions: NormalizedReaction[];
  mentions: Mention[];
  media: MessageMedia | null;
  sharedPost: SharedPost | null;
}

export function normalizeChatMessage(m: ChatMessage): NormalizedRow {
  return {
    id: m.id,
    kind: "message",
    eventText: null,
    body: m.body,
    createdAt: m.createdAt,
    mine: m.mine,
    authorId: m.authorId,
    authorName: m.authorName,
    authorHandle: m.authorHandle,
    authorAvatarPath: m.authorAvatarPath,
    replyTo: m.replyTo
      ? { id: m.replyTo.id, authorLabel: m.replyTo.authorName, body: m.replyTo.body, media: m.replyTo.media, hasPost: m.replyTo.hasPost }
      : null,
    reactions: m.reactions,
    mentions: m.mentions,
    media: m.media,
    sharedPost: m.sharedPost,
  };
}

/**
 * `thread`'s other-person fields are the fallback for a server predating
 * migration 0047 (no per-message sender) — the same fallback DmBubble
 * applies on the web, moved up into the mapper so it happens once instead
 * of at every field read.
 */
export function normalizeDmMessage(m: DmMessage, myId: string, thread: DmThread): NormalizedRow {
  const authorName = m.senderName || thread.otherName || "";
  const authorHandle = m.senderHandle || thread.otherHandle || "";
  const authorAvatarPath = m.senderAvatarPath ?? thread.otherAvatarPath;
  return {
    id: m.id,
    kind: m.eventKind ? "event" : "message",
    eventText: m.eventKind ? describeThreadEvent(m, myId) : null,
    body: m.body,
    createdAt: m.createdAt,
    mine: m.mine,
    authorId: m.senderId,
    authorName,
    authorHandle,
    authorAvatarPath,
    replyTo: m.replyTo
      ? {
          id: m.replyTo.id,
          authorLabel: m.replyTo.senderId === myId ? "You" : m.replyTo.senderName || thread.otherName || "",
          body: m.replyTo.body,
          media: m.replyTo.media,
          hasPost: m.replyTo.hasPost,
        }
      : null,
    reactions: m.reactions,
    mentions: m.mentions,
    media: m.media,
    sharedPost: m.sharedPost,
  };
}

/** A message carrying an attachment renders a named placeholder chip until C10 wires real media rendering. */
export function attachmentWord(media: MessageMedia): string {
  return media.kind === "video" ? "Video" : "Photo";
}
