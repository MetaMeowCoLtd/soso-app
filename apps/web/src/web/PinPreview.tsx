"use client";

import { useState } from "react";
import {
  formatAgo,
  formatCountdown,
  type CategoryConfig,
  type Pin,
  type PostDetail,
  type ReportReason,
  type ResolutionReason,
} from "soso-core";
import { lookOf } from "./theme";

/**
 * The full pin detail — voting, reporting, early resolution — living
 * directly in the map's own bottom sheet rather than a second, separate
 * modal window.
 *
 * Redesigned around one idea: not every action here is equally common or
 * equally weighty, and the layout should say so rather than presenting a
 * flat list of buttons. A vote is the lowest-stakes, most frequent action —
 * it's now two compact icon buttons that double as the count display,
 * always visible on the right of the metadata row, rather than a full-width
 * pair of pill buttons commanding the most visual space on the card. Flagging
 * relevance (or, for the author, removing the post) is the thing someone
 * opening a stale-looking pin is most likely here to do, so it now occupies
 * the prominent slot the vote buttons used to hold. Reporting — rarer, more
 * serious — stays a small, quiet link, unchanged.
 *
 * Corroboration is load-bearing, not decorative — the client never
 * pre-checks whether this is the viewer's own post before deciding what to
 * render; `mine` decides which set of actions shows, and the server enforces
 * the actual rule (`vote_post` rejects self-votes, `flag_post_resolved`
 * rejects self-flags) independent of what the client offers.
 */

interface PinPreviewProps {
  pin: Pin;
  detail: PostDetail | null;
  categories: CategoryConfig[];
  nowSeconds: number;
  onClose: () => void;
  onVote: (postId: string, vote: 1 | -1) => Promise<void>;
  onReport: (postId: string, reason: ReportReason) => Promise<void>;
  onFlagResolved: (postId: string, reason: ResolutionReason) => Promise<void>;
  onResolve: (postId: string) => Promise<void>;
}

const REPORT_REASONS: { label: string; value: ReportReason }[] = [
  { label: "Not true", value: "false_information" },
  { label: "Harassment", value: "harassment" },
  { label: "Privacy", value: "privacy" },
  { label: "Spam", value: "spam" },
];

export default function PinPreview({
  pin,
  detail,
  categories,
  nowSeconds,
  onClose,
  onVote,
  onReport,
  onFlagResolved,
  onResolve,
}: PinPreviewProps) {
  const [voting, setVoting] = useState(false);
  const [voted, setVoted] = useState<1 | -1 | null>(null);
  const [voteNotice, setVoteNotice] = useState<string | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [reported, setReported] = useState(false);
  const [resolutionFlagged, setResolutionFlagged] = useState(false);
  const [removeConfirmOpen, setRemoveConfirmOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [removed, setRemoved] = useState(false);

  const category = categories.find((c) => c.key === pin.category);
  const subtype = category?.subtypes.find((s) => s.key === pin.subtype);
  const look = lookOf(pin.category);

  async function vote(value: 1 | -1) {
    setVoting(true);
    setVoteNotice(null);
    try {
      await onVote(pin.id, value);
      setVoted(value);
    } catch (err) {
      const code = (err as { code?: string }).code;
      setVoteNotice(code === "soso/cannot_vote_own" ? "That's your own post." : "Couldn't send that — try again.");
    } finally {
      setVoting(false);
    }
  }

  async function report(reason: ReportReason) {
    setReportOpen(false);
    await onReport(pin.id, reason);
    setReported(true);
  }

  async function flagResolved(reason: ResolutionReason) {
    await onFlagResolved(pin.id, reason);
    setResolutionFlagged(true);
  }

  async function confirmRemove() {
    setRemoving(true);
    setRemoveError(null);
    try {
      await onResolve(pin.id);
      setRemoved(true);
    } catch {
      setRemoveError("Couldn't remove that — try again.");
    } finally {
      setRemoving(false);
    }
  }

  return (
    <div className="pin-preview">
      <div className="pin-preview-head">
        <div>
          <p className="composer-kicker pin-preview-kicker" style={{ color: look.color }}>
            {look.icon} {subtype?.labelEn ?? category?.labelEn ?? pin.category}
          </p>
          <p className="detail-age pin-preview-age">{formatAgo(pin.createdAt, nowSeconds)}</p>
        </div>
        <button className="pin-preview-close" onClick={onClose} aria-label="Close preview" type="button">
          ×
        </button>
      </div>

      <div className="pin-preview-body">
        {/* Absent, not a loading state, whenever geocoding hasn't finished
            yet or fails outright — an address is a nice-to-have added
            asynchronously after the pin is posted, not something this view
            waits on. */}
        {detail?.address && <p className="detail-address pin-preview-address">📍 {detail.address}</p>}

        {detail?.body && <p className="pin-preview-snippet">{detail.body}</p>}

        <div className="pin-preview-meta">
          <span className="detail-countdown pin-preview-countdown">
            Disappears in {formatCountdown(pin.expiresAt, nowSeconds)}
          </span>

          {/* Always visible, compact, on the right — the icon doubles as
              the count display, so this replaces both the old read-only
              numbers AND the old full-width "Still here" / "Not true"
              pill buttons in one element. A vote is the lowest-stakes,
              most frequent action here; it shouldn't command more visual
              weight than flagging relevance or reporting, both rarer and
              more deliberate. */}
          <span className="pin-preview-vote-buttons" role="group" aria-label="Vote">
            <button
              type="button"
              className={`pin-preview-vote-btn ${voted === 1 ? "active" : ""}`}
              disabled={voting || voted !== null || Boolean(detail?.mine)}
              onClick={() => void vote(1)}
              aria-label="Still here"
              title="Still here"
            >
              👍 {detail?.confirmCount ?? 0}
            </button>
            <button
              type="button"
              className={`pin-preview-vote-btn pin-preview-vote-btn-down ${voted === -1 ? "active" : ""}`}
              disabled={voting || voted !== null || Boolean(detail?.mine)}
              onClick={() => void vote(-1)}
              aria-label="Not true"
              title="Not true"
            >
              👎 {detail?.disputeCount ?? 0}
            </button>
          </span>
        </div>
        {voteNotice && <p className="detail-vote-notice">{voteNotice}</p>}

        {/* The prominent slot — what the vote buttons used to occupy.
            Whoever opens someone else's pin here is most likely doing so
            either to glance at it or because something about it looks
            stale; the author, meanwhile, has exactly one thing they'd come
            here to do with their own post. Each gets that one thing,
            immediately visible, rather than a menu of options. */}
        {detail?.mine ? (
          <div className="pin-preview-own">
            <p className="detail-own">You posted this.</p>
            {removed ? (
              <p className="detail-own">Removed — thanks for keeping the map current.</p>
            ) : removeConfirmOpen ? (
              <div className="detail-remove-confirm">
                <p>This removes your post immediately, before its normal expiry. This can't be undone.</p>
                <div className="detail-remove-confirm-actions">
                  <button type="button" onClick={() => setRemoveConfirmOpen(false)} disabled={removing}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="detail-remove-confirm-yes"
                    onClick={() => void confirmRemove()}
                    disabled={removing}
                  >
                    {removing ? "Removing…" : "Yes, remove it"}
                  </button>
                </div>
                {removeError && <p className="detail-vote-notice">{removeError}</p>}
              </div>
            ) : (
              <button
                className="pin-preview-primary-action pin-preview-remove-action"
                type="button"
                onClick={() => setRemoveConfirmOpen(true)}
              >
                Remove this now
              </button>
            )}
          </div>
        ) : resolutionFlagged ? (
          <p className="detail-own">Thanks — we&rsquo;ve let the person who posted this know.</p>
        ) : (
          <div className="pin-preview-primary">
            <p className="pin-preview-primary-label">Is this still relevant?</p>
            <div className="pin-preview-primary-actions">
              <button
                type="button"
                className="pin-preview-primary-action"
                onClick={() => void flagResolved("resolved")}
              >
                ✅ Resolved
              </button>
              <button
                type="button"
                className="pin-preview-primary-action pin-preview-primary-action-muted"
                onClick={() => void flagResolved("out_of_date")}
              >
                📅 Out of date
              </button>
            </div>
          </div>
        )}

        {!detail?.mine && (
          <div className="pin-preview-links">
            {reported ? (
              <p className="detail-own">Reported — thanks, we&rsquo;ll look at it.</p>
            ) : reportOpen ? (
              <div className="detail-report-reasons">
                {REPORT_REASONS.map((r) => (
                  <button key={r.value} type="button" onClick={() => void report(r.value)}>
                    {r.label}
                  </button>
                ))}
              </div>
            ) : (
              <button className="detail-report-link" type="button" onClick={() => setReportOpen(true)}>
                Report this post
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
