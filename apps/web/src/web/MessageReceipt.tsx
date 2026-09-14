"use client";

import { formatSeenAt } from "soso-core";

/**
 * The "who has read this" line under a message.
 *
 * ONE COMPONENT, TWO FORMS, AND THE SECOND ONE IS COMING
 * ---------------------------------------------------------------------
 * A direct message gets a sentence ("Seen 1h ago") because there is exactly
 * one other person and the interesting part is WHEN. The shared room gets a
 * count ("Seen by 12") because it has no membership at all — migration 0015
 * made one global channel, so the readers are an unbounded set of strangers
 * whose faces would mean nothing and whose reading habits are not this
 * app's to publish.
 *
 * Group conversations will want the third form: a row of small avatars, the
 * way Instagram draws it. That is why this is one component taking a
 * discriminated `receipt` rather than two ad-hoc spans in two files — when
 * `{ kind: "people", readers: [...] }` arrives it lands here, next to the
 * other two, and both existing surfaces keep rendering exactly as they do
 * now. The caller decides WHICH message carries a receipt; this decides what
 * a receipt looks like.
 */

export type MessageReceiptState =
  /** A one-to-one conversation: when the other person last read. */
  | { kind: "seen-at"; readAt: string }
  /** A room with no membership: how many other people have read this far. */
  | { kind: "count"; count: number };

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
