"use client";

import { useState } from "react";
import {
  ERROR_MESSAGES_EN,
  formatAgo,
  formatCountdown,
  type CategoryConfig,
  type Pin,
  type PostDetail,
  type ReportReason,
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
 * it's two compact icon buttons that double as the count display, always
 * visible on the right of the metadata row, rather than a full-width pair
 * of pill buttons commanding the most visual space on the card.
 *
 * As of `20260902000020_validity_voting.sql`, that vote is also the ONLY
 * validity signal — there used to be a second, separate one here ("Is this
 * still relevant? ✅ Resolved / 📅 Out of date", notifying the post's
 * author and leaving removal up to them). That's gone: a strong enough run
 * of 👎 now drains a pin's colour and then fades it (see SosoMap's use of
 * `pinOpacity` / `pinSaturation`) and, past a threshold, expires the post outright — the
 * same way the author's own "Remove this now" already does. Reporting —
 * rarer, aimed at a moderator rather than at the post's own validity —
 * stays a small, quiet link, unchanged.
 *
 * Corroboration is load-bearing, not decorative — the client never
 * pre-checks whether this is the viewer's own post before deciding what to
 * render; `mine` decides which set of actions shows, and the server
 * enforces the actual rule (`vote_post` rejects self-votes) independent of
 * what the client offers.
 */

interface PinPreviewProps {
  pin: Pin;
  detail: PostDetail | null;
  categories: CategoryConfig[];
  nowSeconds: number;
  onClose: () => void;
  onVote: (postId: string, vote: 1 | -1) => Promise<void>;
  onReport: (postId: string, reason: ReportReason) => Promise<void>;
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
  onResolve,
}: PinPreviewProps) {
  const [voting, setVoting] = useState(false);
  const [voted, setVoted] = useState<1 | -1 | null>(null);
  const [voteNotice, setVoteNotice] = useState<string | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  const [reported, setReported] = useState(false);
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
    setReportError(null);
    try {
      await onReport(pin.id, reason);
      setReported(true);
    } catch (err) {
      const code = (err as { code?: string }).code as keyof typeof ERROR_MESSAGES_EN | undefined;
      setReportError(code && code in ERROR_MESSAGES_EN ? ERROR_MESSAGES_EN[code] : ERROR_MESSAGES_EN["soso/unknown"]);
    }
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
              weight than reporting, which is rarer and more deliberate —
              even though, as of validity voting, a vote can now do more
              than it used to (see the module doc above). */}
          <span className="pin-preview-vote-buttons" role="group" aria-label="Vote">
            <button
              type="button"
              className={`pin-preview-vote-btn ${voted === 1 ? "active" : ""}`}
              disabled={voting || voted !== null || Boolean(detail?.mine)}
              onClick={() => void vote(1)}
              aria-label="Still valid"
              title="Still valid"
            >
              👍 {detail?.confirmCount ?? 0}
            </button>
            <button
              type="button"
              className={`pin-preview-vote-btn pin-preview-vote-btn-down ${voted === -1 ? "active" : ""}`}
              disabled={voting || voted !== null || Boolean(detail?.mine)}
              onClick={() => void vote(-1)}
              aria-label="No longer valid"
              title="No longer valid — enough of these will remove the pin"
            >
              👎 {detail?.disputeCount ?? 0}
            </button>
          </span>
        </div>
        {voteNotice && <p className="detail-vote-notice">{voteNotice}</p>}

        {/* The prominent slot the vote buttons used to share with a second,
            now-removed signal. Only the author has a deliberate action to
            take here — everyone else's validity signal is the vote buttons
            above, which is the whole point of this migration: one signal,
            not two competing for the same "is this still good" question. */}
        {detail?.mine && (
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
            {reportError && <p className="detail-vote-notice">{reportError}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
