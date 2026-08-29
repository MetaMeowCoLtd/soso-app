"use client";

import { useState } from "react";
import {
  formatAgo,
  formatCountdown,
  type CategoryConfig,
  type Pin,
  type PostDetail,
  type ReportReason,
} from "soso-core";
import { lookOf } from "./theme";

/**
 * Detail for one pin, fetched on selection.
 *
 * Two jobs beyond showing the post: corroboration and reporting.
 *
 * Corroboration is load-bearing, not decorative. "Still here" and "not true"
 * are how a map of unverified claims stays useful without a moderator reading
 * every post — enough disputes auto-hide the pin server-side. The client does
 * not pre-check whether this is the viewer's own post before offering the
 * buttons; it just calls `votePost` and shows whatever the server says. That's
 * "server-side validation" made concrete: the client doesn't need a `mine`
 * check of its own, because `vote_post` already rejects self-votes, and the
 * client only has to render the resulting error.
 */

interface ReportDetailProps {
  pin: Pin;
  detail: PostDetail | null;
  categories: CategoryConfig[];
  nowSeconds: number;
  onClose: () => void;
  onVote: (postId: string, vote: 1 | -1) => Promise<void>;
  onReport: (postId: string, reason: ReportReason) => Promise<void>;
}

const REPORT_REASONS: { label: string; value: ReportReason }[] = [
  { label: "Not true", value: "false_information" },
  { label: "Harassment", value: "harassment" },
  { label: "Privacy", value: "privacy" },
  { label: "Spam", value: "spam" },
];

export default function ReportDetail({
  pin,
  detail,
  categories,
  nowSeconds,
  onClose,
  onVote,
  onReport,
}: ReportDetailProps) {
  const [voting, setVoting] = useState(false);
  const [voted, setVoted] = useState<1 | -1 | null>(null);
  const [voteNotice, setVoteNotice] = useState<string | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [reported, setReported] = useState(false);

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

          {detail?.body && <p className="detail-body">{detail.body}</p>}

          <p className="detail-countdown">Disappears in {formatCountdown(pin.expiresAt, nowSeconds)}</p>

          {detail ? (
            <p className="detail-corroboration">
              {detail.confirmCount === 0 && detail.disputeCount === 0
                ? "Nobody has confirmed this yet."
                : `${detail.confirmCount} confirmed, ${detail.disputeCount} disputed.`}
            </p>
          ) : (
            <p className="detail-corroboration">Loading…</p>
          )}

          {detail?.mine ? (
            <p className="detail-own">You posted this.</p>
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
            <button className="detail-report-link" type="button" onClick={() => setReportOpen(true)}>
              Report this post
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
