"use client";

import { useState } from "react";
import { formatAgo } from "soso-core";
import type { UsePresenceResult } from "./usePresence";

/**
 * The people frame.
 *
 * Docked open by default rather than a modal — this sits on the home screen
 * as a fixture, not a screen someone opens and dismisses. That changes the
 * copy budget: a one-time modal can afford an explanatory paragraph per
 * control, a permanent fixture cannot, so the "why" that used to be visible
 * body text now lives in `title`/`aria-label` (still reachable, just not
 * taking up standing space). The two things that must never be conflated —
 * "Around here" is an anonymous count anyone can see, "Your people" is a
 * named list gated by mutual follow — are kept as two visually distinct
 * blocks even with the prose gone, so the boundary is still legible at a
 * glance and not just in a tooltip.
 */

interface PeoplePanelProps {
  presence: UsePresenceResult;
  demoMode: boolean;
  onClose: () => void;
}

export default function PeoplePanel({ presence, demoMode, onClose }: PeoplePanelProps) {
  const [handleInput, setHandleInput] = useState("");
  const [confirmBlock, setConfirmBlock] = useState<string | null>(null);
  const nowSeconds = Math.floor(Date.now() / 1000);

  async function submitFollow() {
    const handle = handleInput.trim().replace(/^@/, "");
    if (!handle) return;
    await presence.follow(handle);
    setHandleInput("");
  }

  return (
    <aside className="people-frame" aria-label="People">
      <div className="people-frame-head">
        <span className="people-frame-title">People</span>
        {presence.me && <span className="people-frame-handle">@{presence.me.handle}</span>}
        <button className="people-frame-close" onClick={onClose} aria-label="Close" type="button">
          ×
        </button>
      </div>

      {demoMode ? (
        <p className="people-empty">Demo mode has nobody else to see — connect a backend.</p>
      ) : (
        <>
          <div
            className="area-activity"
            title="A count only — nobody can see who, including you."
          >
            <span className="area-activity-number">{presence.areaCount ?? "–"}</span>
            <span className="area-activity-label">nearby</span>
          </div>

          <label
            className="presence-toggle"
            title="Adds you to the count above and lets mutual follows see you as online. Shares only your ward, never an exact spot."
          >
            <input
              type="checkbox"
              checked={presence.sharing}
              onChange={(e) => presence.setSharing(e.target.checked)}
            />
            <span>Share presence here</span>
          </label>

          <div className="follow-row">
            <input
              value={handleInput}
              onChange={(e) => setHandleInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submitFollow();
              }}
              placeholder="add by handle"
              aria-label="Add someone by their handle"
              maxLength={21}
            />
            <button type="button" onClick={() => void submitFollow()} disabled={presence.busy}>
              Add
            </button>
          </div>

          {presence.error && <p className="people-hint">{presence.error}</p>}

          {presence.friends.length === 0 ? (
            <p className="people-empty">Nobody yet.</p>
          ) : (
            <ul className="friend-list">
              {presence.friends.map((friend) => (
                <li key={friend.id} className="friend-row">
                  <span
                    className={`friend-dot ${friend.isOnline ? "online" : ""}`}
                    aria-hidden="true"
                  />
                  <span className="friend-main">
                    <span className="friend-name">{friend.displayName}</span>
                    <span className="friend-meta">
                      @{friend.handle}
                      {friend.isOnline
                        ? friend.sameArea
                          ? " · online, near you"
                          : " · online"
                        : friend.lastSeenAt
                          ? ` · ${formatAgo(
                              Math.floor(new Date(friend.lastSeenAt).getTime() / 1000),
                              nowSeconds,
                            )}`
                          : " · offline"}
                    </span>
                  </span>
                  <button
                    type="button"
                    className={`tier-star ${friend.tier === "close" ? "active" : ""}`}
                    onClick={() =>
                      void presence.setFriendTier(
                        friend.id,
                        friend.tier === "close" ? "standard" : "close",
                      )
                    }
                    aria-pressed={friend.tier === "close"}
                    aria-label={
                      friend.tier === "close"
                        ? `Stop letting ${friend.displayName} see your close-friends posts`
                        : `Let ${friend.displayName} see your close-friends posts`
                    }
                    title={
                      friend.tier === "close"
                        ? "Close friend — can see your close-friends posts"
                        : "Mark as close friend"
                    }
                  >
                    {friend.tier === "close" ? "★" : "☆"}
                  </button>
                  {confirmBlock === friend.id ? (
                    <span className="friend-confirm">
                      <button type="button" onClick={() => void presence.block(friend.id)}>
                        Block
                      </button>
                      <button type="button" onClick={() => setConfirmBlock(null)}>
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <span className="friend-actions">
                      <button type="button" onClick={() => void presence.unfollow(friend.id)}>
                        Remove
                      </button>
                      <button type="button" onClick={() => setConfirmBlock(friend.id)}>
                        Block
                      </button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </aside>
  );
}
