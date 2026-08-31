"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
  // Which friend's ⋯ menu is open, if any. Remove/Block used to sit directly
  // on the row; tucking both behind a menu is the point of this change, so a
  // stray tap on the row itself can no longer trigger either.
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  // The popover is rendered in a portal (see below) so it can float above the
  // frame instead of being clipped by it, which means its position has to be
  // computed from the trigger button's rect rather than relying on normal
  // in-flow `position: absolute` placement.
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLSpanElement | null>(null);
  const nowSeconds = Math.floor(Date.now() / 1000);

  function closeMenu() {
    setOpenMenu(null);
    setConfirmBlock(null);
    setMenuPos(null);
  }

  function openMenuFor(id: string, trigger: HTMLButtonElement) {
    const rect = trigger.getBoundingClientRect();
    // Right-align the popover to the trigger, flip above if there isn't room
    // below — the frame sits near the top of the screen, so a long friend
    // list can otherwise push this off the bottom of the viewport.
    const estimatedHeight = 84;
    const top =
      rect.bottom + estimatedHeight > window.innerHeight
        ? rect.top - estimatedHeight - 4
        : rect.bottom + 4;
    setMenuPos({ top, left: rect.right - 104 });
    triggerRef.current = trigger;
    setOpenMenu(id);
  }

  // Outside click / Escape closes whichever menu is open, including a
  // pending block confirmation — a popover that only closes via its own
  // buttons is easy to get stuck in. Both the trigger and the portaled
  // popover count as "inside".
  useEffect(() => {
    if (!openMenu) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        (!triggerRef.current || !triggerRef.current.contains(target)) &&
        (!popoverRef.current || !popoverRef.current.contains(target))
      ) {
        closeMenu();
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeMenu();
    };
    // Reposition (or close) on scroll/resize so the popover never drifts away
    // from its trigger — the frame itself scrolls independently of the page.
    const onReflow = () => {
      if (triggerRef.current) openMenuFor(openMenu, triggerRef.current);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onReflow, true);
    window.addEventListener("resize", onReflow);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onReflow, true);
      window.removeEventListener("resize", onReflow);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openMenu]);

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

          <button
            type="button"
            role="switch"
            aria-checked={presence.sharing}
            className={`presence-toggle ${presence.sharing ? "active" : ""}`}
            title="Adds you to the count above and lets mutual follows see you as online. Shares only your ward, never an exact spot."
            onClick={() => presence.setSharing(!presence.sharing)}
          >
            <span className="presence-toggle-dot" aria-hidden="true" />
            Sharing
          </button>

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
                  <span className="friend-menu">
                    <button
                      type="button"
                      className="friend-menu-trigger"
                      onClick={(e) =>
                        openMenu === friend.id ? closeMenu() : openMenuFor(friend.id, e.currentTarget)
                      }
                      aria-haspopup="menu"
                      aria-expanded={openMenu === friend.id}
                      aria-label={`More options for ${friend.displayName}`}
                    >
                      ⋯
                    </button>
                    {openMenu === friend.id &&
                      menuPos &&
                      createPortal(
                        confirmBlock === friend.id ? (
                          <span
                            className="friend-popover friend-confirm"
                            role="menu"
                            ref={popoverRef}
                            style={{ top: menuPos.top, left: menuPos.left }}
                          >
                            <button
                              type="button"
                              onClick={() => {
                                void presence.block(friend.id);
                                closeMenu();
                              }}
                            >
                              Yes, block
                            </button>
                            <button type="button" onClick={() => setConfirmBlock(null)}>
                              Cancel
                            </button>
                          </span>
                        ) : (
                          <span
                            className="friend-popover"
                            role="menu"
                            ref={popoverRef}
                            style={{ top: menuPos.top, left: menuPos.left }}
                          >
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() => {
                                void presence.unfollow(friend.id);
                                closeMenu();
                              }}
                            >
                              Remove
                            </button>
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() => setConfirmBlock(friend.id)}
                            >
                              Block
                            </button>
                          </span>
                        ),
                        document.body,
                      )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </aside>
  );
}
