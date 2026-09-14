"use client";

import { formatSeenAt } from "soso-core";
import { Avatar } from "./Avatar";

/**
 * The "who has read this" line under a message.
 *
 * ONE COMPONENT, THREE FORMS, ONE PER SURFACE
 * ---------------------------------------------------------------------
 * A DIRECT MESSAGE gets a sentence ("Seen 1h ago"): there is exactly one
 * other person, so the only thing left to say is when.
 *
 * THE SHARED ROOM gets a count ("Seen by 12"). It has no membership at all —
 * migration 0015 made one global channel — so its readers are an unbounded
 * set of strangers whose faces would mean nothing and whose reading habits
 * are not this app's to publish.
 *
 * A GROUP gets faces, the way Instagram draws it, which arrived with
 * migration 0047. Here the identities are the whole content: five people can
 * read a message and the one you are waiting on is a specific person.
 *
 * That the three live in one component behind a discriminated `receipt` is
 * what let the third be added without touching either of the others. The
 * caller decides WHICH message carries a receipt; this decides what a receipt
 * looks like.
 */

export type MessageReceiptState =
  /** A one-to-one conversation: when the other person last read. */
  | { kind: "seen-at"; readAt: string }
  /** A room with no membership: how many other people have read this far. */
  | { kind: "count"; count: number }
  /**
   * A group: who, by face.
   *
   * `src` is a resolved URL and not an `AvatarPath`, for the reason `Avatar`
   * itself gives — turning one into the other needs the gateway, and a
   * presentational component that reached for it could not be rendered without
   * one.
   */
  | { kind: "people"; readers: { id: string; name: string; handle: string; src: string | null }[] };

/**
 * How many faces fit before the row stops being faces and starts being a
 * smudge. Five at 16px is about 90px of receipt, which sits under a bubble
 * without pushing the timestamp off a narrow screen.
 */
const MAX_FACES = 5;

export default function MessageReceipt({
  receipt,
  nowSeconds,
}: {
  receipt: MessageReceiptState;
  /**
   * Passed in rather than read from `Date.now()` here, so every receipt in a
   * list agrees with every timestamp beside it and they all re-render on the
   * same tick instead of each drifting on its own.
   */
  nowSeconds: number;
}) {
  if (receipt.kind === "people") {
    // Never rendered empty by the caller, so there is always at least one
    // face here.
    const shown = receipt.readers.slice(0, MAX_FACES);
    const hidden = receipt.readers.length - shown.length;
    return (
      <span
        className="message-receipt faces"
        // The faces are aria-hidden inside `Avatar`, so without this the whole
        // receipt would announce as nothing at all.
        aria-label={`Seen by ${receipt.readers.map((r) => r.name).join(", ")}`}
      >
        {shown.map((reader) => (
          <Avatar key={reader.id} name={reader.name} seed={reader.handle} src={reader.src} size={16} />
        ))}
        {hidden > 0 && <span className="message-receipt-more">+{hidden}</span>}
      </span>
    );
  }

  if (receipt.kind === "count") {
    // Zero is not rendered at all by the caller, so this only ever shows a
    // real number. Singular matters: "Seen by 1 people" is the kind of
    // detail that makes an app feel unfinished.
    return (
      <span className="message-receipt">
        Seen by {receipt.count} {receipt.count === 1 ? "person" : "people"}
      </span>
    );
  }

  return (
    <span className="message-receipt">
      {formatSeenAt(Math.floor(new Date(receipt.readAt).getTime() / 1000), nowSeconds)}
    </span>
  );
}
