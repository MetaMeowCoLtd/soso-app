"use client";

import { useState } from "react";
import { formatAgo } from "soso-core";
import type { UsePresenceResult } from "./usePresence";

/**
 * The people panel.
 *
 * Two distinct sections on purpose, because they have different privacy
 * properties and conflating them would misrepresent both:
 *
 *   - "Around here" is a COUNT. It is what makes the area feel inhabited, and
 *     it names nobody. Anyone can see it.
 *   - "Your people" is a named list with online dots, and appears only for
 *     mutual follows. The database enforces that; this component could not
 *     show a stranger's status even if it tried.
 *
 * The copy here does real work. People reasonably assume a "who's nearby"
 * feature broadcasts their location, so the panel states plainly what is and
 * is not shared rather than burying it in a settings screen.
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

  const online = presence.friends.filter((f) => f.isOnline);

  return (
    <div className="composer-backdrop" role="presentation" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" aria-label="People" onMouseDown={(e) => e.stopPropagation()}>
        <div className="people-panel">
          <button className="composer-close" onClick={onClose} aria-label="Close" type="button">
            ×
          </button>

          <p className="composer-kicker">✦ People</p>
          <h2>Around here</h2>

          {demoMode ? (
            <p className="people-empty">
              Demo mode is just this browser, so there is nobody else to see. Connect a backend to
              use this.
            </p>
          ) : (
            <>
              <div className="area-activity">
                <span className="area-activity-number">{presence.areaCount ?? "–"}</span>
                <span className="area-activity-label">
                  {presence.areaCount === null
                    ? "checking this area…"
                    : presence.areaCount === 0
                      ? "nobody sharing right now"
                      : presence.areaCount === 1
                        ? "person active in this area"
                        : "people active in this area"}
                </span>
              </div>
              <p className="people-note">
                A count only. Nobody can see who is here, including you.
              </p>

              <label className="presence-toggle">
                <input
                  type="checkbox"
                  checked={presence.sharing}
                  onChange={(e) => presence.setSharing(e.target.checked)}
                />
                <span>
                  <strong>Count me in this area</strong>
                  <em>
                    Adds you to the number above and lets people you both follow see you as online.
                    Shares your ward, never your exact spot. Off by default.
                  </em>
                </span>
              </label>

              <h2 className="people-heading">Your people</h2>
              <p className="people-note">
                You only see each other once you have both added each other.
                {presence.me && (
                  <>
                    {" "}
                    Your handle is <strong>@{presence.me.handle}</strong>.
                  </>
                )}
              </p>

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
                <p className="people-empty">
                  Nobody yet. Share your handle with someone and add theirs.
                </p>
              ) : (
                <>
                  <p className="people-note">
                    {online.length === 0
                      ? "Nobody online right now."
                      : `${online.length} online now.`}
                  </p>
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
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
