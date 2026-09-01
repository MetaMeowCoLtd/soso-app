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
 * This used to be two components: this one as a read-only glance, and
 * `ReportDetail` as a backdrop-blocking modal one "See more" tap away, on
 * the reasoning that voting/reporting are deliberate actions that shouldn't
 * happen by accident while someone's thumb is mid-pan. That reasoning still
 * applies to why nothing here fires on a bare tap — but the sheet the pin
 * lives in is already exactly as interactive as it always is, so a second,
 * separate blocking surface for the same pin's own actions was one more
 * window than the map needed. Everything from that modal now lives here
 * instead, in the same non-blocking sheet: the map behind it never loses
 * focus, and tapping a different pin just swaps this card's content.
 *
 * Corroboration is load-bearing, not decorative — see the original
 * ReportDetail's note on this, preserved: the client never pre-checks
 * whether this is the viewer's own post before offering vote/report/resolve
 * buttons; `mine` decides which set renders, and the server enforces the
 * actual rule (`vote_post` rejects self-votes) independent of what the
 * client shows.
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

const RESOLUTION_REASONS: { label: string; value: ResolutionReason }[] = [
  { label: "Looks resolved", value: "resolved" },
  { label: "Out of date", value: "out_of_date" },
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
  const [resolutionOpen, setResolutionOpen] = useState(false);
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
    setResolutionOpen(false);
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
              <button className="detail-remove-link" type="button" onClick={() => setRemoveConfirmOpen(true)}>
                Remove this now
              </button>
            )}
          </div>
        ) : (
          <>
            <div className="detail-actions pin-preview-actions">
              <button
                type="button"
                className={`detail-vote ${voted === 1 ? "active" : ""}`}
                disabled={voting || voted !== null}
                onClick={() => void vote(1)}
              >
                👀 Still here
              </button>
              <button
                type="button"
                className={`detail-vote detail-vote-dispute ${voted === -1 ? "active" : ""}`}
                disabled={voting || voted !== null}
                onClick={() => void vote(-1)}
              >
                Not true
              </button>
            </div>
            {voteNotice && <p className="detail-vote-notice">{voteNotice}</p>}

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

              {resolutionFlagged ? (
                <p className="detail-own">Thanks — we&rsquo;ve let the person who posted this know.</p>
              ) : resolutionOpen ? (
                <div className="detail-report-reasons">
                  {RESOLUTION_REASONS.map((r) => (
                    <button key={r.value} type="button" onClick={() => void flagResolved(r.value)}>
                      {r.label}
                    </button>
                  ))}
                </div>
              ) : (
                <button className="detail-report-link" type="button" onClick={() => setResolutionOpen(true)}>
                  Is this still relevant?
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
