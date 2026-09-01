"use client";

import { formatAgo, formatCountdown, type CategoryConfig, type Pin, type PostDetail } from "soso-core";
import { lookOf } from "./theme";

/**
 * A quick, non-blocking overview of one pin, living inside the map's own
 * bottom sheet rather than a modal.
 *
 * The full `ReportDetail` modal (voting, reporting) sits behind a backdrop
 * that captures every click, by design — voting and reporting are
 * deliberate actions that should not happen by accident while someone is
 * mid-pan. But that same backdrop makes it the wrong thing to show for
 * "I just want to see what this pin is while I keep looking around,"
 * which is a materially different, much more common interaction: tapping
 * pin after pin while panning between them. This is that lighter path —
 * the sheet stays exactly as interactive as it always is, the map behind
 * it never loses focus, and tapping a different pin just swaps this
 * card's content rather than requiring a close-then-reopen.
 *
 * Deliberately read-only. Voting and reporting stay behind the explicit
 * "See more" step into the full modal — not because they're technically
 * harder to add here, but because a non-blocking surface a thumb can
 * brush past while panning is the wrong place for an action that changes
 * something for the post's author.
 */

interface PinPreviewProps {
  pin: Pin;
  detail: PostDetail | null;
  categories: CategoryConfig[];
  nowSeconds: number;
  onClose: () => void;
  onExpand: () => void;
}

export default function PinPreview({ pin, detail, categories, nowSeconds, onClose, onExpand }: PinPreviewProps) {
  const category = categories.find((c) => c.key === pin.category);
  const subtype = category?.subtypes.find((s) => s.key === pin.subtype);
  const look = lookOf(pin.category);

  return (
    <div className="pin-preview">
      <div className="pin-preview-head">
        <p className="composer-kicker pin-preview-kicker" style={{ color: look.color }}>
          {look.icon} {subtype?.labelEn ?? category?.labelEn ?? pin.category}
        </p>
        <button className="pin-preview-close" onClick={onClose} aria-label="Close preview" type="button">
          ×
        </button>
      </div>

      <p className="detail-age pin-preview-age">{formatAgo(pin.createdAt, nowSeconds)}</p>

      {/* Genuine at-a-glance info, unlike voting/reporting below — knowing
          roughly where something is belongs in a quick overview just as
          much as when it happened. Absent, not a loading state, whenever
          geocoding hasn't finished yet or failed outright; see the same
          reasoning in ReportDetail. */}
      {detail?.address && <p className="detail-address pin-preview-address">📍 {detail.address}</p>}

      {/* Clamped rather than the full body: a glance shouldn't need
          scrolling inside a card this small. "See more" is exactly that
          escape hatch, not a redundant affordance. */}
      {detail?.body && <p className="pin-preview-snippet">{detail.body}</p>}

      <div className="pin-preview-meta">
        <span className="detail-countdown pin-preview-countdown">
          Disappears in {formatCountdown(pin.expiresAt, nowSeconds)}
        </span>
        {detail ? (
          detail.confirmCount === 0 && detail.disputeCount === 0 ? (
            <span className="detail-corroboration pin-preview-corroboration">No confirmations yet</span>
          ) : (
            <span className="pin-preview-vote-counts">
              <span className="detail-vote-count detail-vote-count-up">👍 {detail.confirmCount}</span>
              <span className="detail-vote-count detail-vote-count-down">👎 {detail.disputeCount}</span>
            </span>
          )
        ) : (
          <span className="detail-corroboration pin-preview-corroboration">Loading…</span>
        )}
      </div>

      <button className="pin-preview-expand" onClick={onExpand} type="button">
        See more &amp; respond →
      </button>
    </div>
  );
}
