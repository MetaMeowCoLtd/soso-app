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
 * Detail for one pin, fetched on selection.
 *
 * Corroboration is load-bearing, not decorative. "Still here" and "not true"
 * are how a map of unverified claims stays useful without a moderator reading
 * every post — enough disputes auto-hide the pin server-side. The client does
 * not pre-check whether this is the viewer's own post before offering the
 * buttons; it just calls `votePost` and shows whatever the server says. That's
 * "server-side validation" made concrete: the client doesn't need a `mine`
 * check of its own, because `vote_post` already rejects self-votes, and the
 * client only has to render the resulting error.
 *
 * Early resolution follows the identical shape as reporting, deliberately: a
 * quiet link that expands into a small set of reasons, then a confirmation
 * line. Someone who isn't the author can flag a post as resolved or out of
 * date, which notifies the author — it never removes anything itself. Only
 * the author sees a "remove this now" affordance at all, and only for their
 * own posts, matching resolve_post's own server-side restriction rather than
 * the client inventing a permission check the server doesn't also enforce.
 */

interface ReportDetailProps {
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

export default function ReportDetail({
  pin,
  detail,
  categories,
  nowSeconds,
  onClose,
  onVote,
  onReport,
  onFlagResolved,
  onResolve,
}: ReportDetailProps) {
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
    <div className="composer-backdrop" role="presentation" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Report details" onMouseDown={(e) => e.stopPropagation()}>
        <div className="detail-card">
          <button className="composer-close" onClick={onClose} aria-label="Close details" type="button">
            ×
          </button>
          <p className="composer-kicker" style={{ color: look.color }}>
            {look.icon} {subtype?.labelEn ?? category?.labelEn ?? pin.category}
          </p>
          <p className="detail-age">{formatAgo(pin.createdAt, nowSeconds)}</p>

          {/* Absent, not a loading state, whenever geocoding hasn't finished
              (or never will — the request can simply fail). Showing nothing
              here is the correct rendering of "we don't have this," not a
              gap to fill with a spinner that might spin forever. */}
          {detail?.address && <p className="detail-address">📍 {detail.address}</p>}

          {detail?.body && <p className="detail-body">{detail.body}</p>}

          <p className="detail-countdown">Disappears in {formatCountdown(pin.expiresAt, nowSeconds)}</p>

          {detail ? (
            detail.confirmCount === 0 && detail.disputeCount === 0 ? (
              <p className="detail-corroboration">Nobody has confirmed this yet.</p>
            ) : (
              <div className="detail-vote-counts" aria-label="Corroboration counts">
                <span className="detail-vote-count detail-vote-count-up">👍 {detail.confirmCount}</span>
                <span className="detail-vote-count detail-vote-count-down">👎 {detail.disputeCount}</span>
              </div>
            )
          ) : (
            <p className="detail-corroboration">Loading…</p>
          )}

          {detail?.mine ? (
            <>
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
                  className="detail-remove-link"
                  type="button"
                  onClick={() => setRemoveConfirmOpen(true)}
                >
                  Remove this now
                </button>
              )}
            </>
          ) : (
            <div className="detail-actions">
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
          )}
          {voteNotice && <p className="detail-vote-notice">{voteNotice}</p>}

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
            !detail?.mine && (
              <button className="detail-report-link" type="button" onClick={() => setReportOpen(true)}>
                Report this post
              </button>
            )
          )}

          {/* Only for someone else's post — the author has "Remove this now"
              above instead, which does directly what this would otherwise
              only ask them about. */}
          {!detail?.mine &&
            (resolutionFlagged ? (
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
            ))}
        </div>
      </div>
    </div>
  );
}
