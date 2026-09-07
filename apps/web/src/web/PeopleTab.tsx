"use client";

import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { formatAgo, type Friend } from "soso-core";
import { Avatar } from "./Avatar";
import { Icon, ICONS } from "./Icon";
import type { UsePresenceResult } from "./usePresence";

/**
 * People: friends, presence, and the social graph — now its own tab
 * alongside Map, Feed and Chat rather than the small docked frame that
 * used to float over the map (PeoplePanel, removed).
 *
 * WHY IT STOPPED BEING A PANEL
 * ---------------------------------------------------------------------
 * The frame was ~220px wide and sat on top of the map, so everything in
 * it had to be miniature: a two-line row per person, a star and a "⋯" the
 * size of the text beside them, and a follow field squeezed under the
 * list. That is a fine shape for a glanceable widget and a bad one for
 * the screen where you actually manage who can see you. As its own tab it
 * gets the full width, which is what makes room for the things below
 * that the panel had no space for at all — a real presence switch with
 * its reasoning attached, per-person avatars, filters, and search.
 *
 * WHAT THE LAYOUT IS DOING
 * ---------------------------------------------------------------------
 * Identity and privacy first (your handle, the sharing switch), then the
 * counts, then the list. That order is deliberate and is the one thing
 * here that is NOT copied from the social apps this otherwise resembles:
 * those put the list first because their entire product is the list. In
 * this app the question "is anyone able to see me right now" matters more
 * than any individual row, and the answer should not be something you
 * scroll to find.
 *
 * The counts double as the list's filters, which is the trick the
 * "193 followers / 382 following" header pulls: a number is a better
 * filter label than the word "Online" alone, because it tells you whether
 * tapping it is worth anything before you tap.
 */

interface PeopleTabProps {
  presence: UsePresenceResult;
  demoMode: boolean;
  /**
   * Opens a direct-message thread with a friend. Handled by page.tsx rather
   * than here because the thread view is a full-screen surface that must
   * also be reachable from the Chat tab's inbox — the same reason
   * ThoughtThread lives up there instead of inside FeedTab.
   */
  onMessage: (userId: string) => void;
}

type Filter = "all" | "online" | "close";

/**
 * Null for anyone offline, which is most of a list most of the time —
 * their avatar dot already says so, and a column of rows each captioned
 * "Offline" is four words of noise per screen that never change. The
 * server helps here: `friends_presence` deliberately does not expose stale
 * timestamps (`lastSeenAt` is null unless they are online right now), so
 * there is no "last seen 3 days ago" worth showing in its place.
 */
function statusOf(friend: Friend, nowSeconds: number): string | null {
  if (friend.isOnline) return friend.sameArea ? "Online · near you" : "Online";
  return friend.lastSeenAt
    ? formatAgo(Math.floor(new Date(friend.lastSeenAt).getTime() / 1000), nowSeconds)
    : null;
}

export default function PeopleTab({ presence, demoMode, onMessage }: PeopleTabProps) {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [handleInput, setHandleInput] = useState("");
  const [copied, setCopied] = useState(false);
  // The row whose action sheet is open, plus whether it has escalated to the
  // block confirmation. A bottom sheet rather than the old popover anchored
  // to a "⋯": on a full-width row the actions are destructive enough to
  // deserve deliberate, thumb-reachable targets instead of a 100px menu.
  const [sheetFor, setSheetFor] = useState<Friend | null>(null);
  const [confirmBlock, setConfirmBlock] = useState(false);

  const nowSeconds = Math.floor(Date.now() / 1000);
  const friends = presence.friends;

  const counts = useMemo(
    () => ({
      all: friends.length,
      online: friends.filter((f) => f.isOnline).length,
      close: friends.filter((f) => f.tier === "close").length,
    }),
    [friends],
  );

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (
      friends
        .filter((f) => (filter === "online" ? f.isOnline : filter === "close" ? f.tier === "close" : true))
        .filter(
          (f) =>
            needle.length === 0 ||
            f.displayName.toLowerCase().includes(needle) ||
            f.handle.toLowerCase().includes(needle),
        )
        // Online first, then alphabetical: a presence list whose whole point is
        // "who is around" should not bury the two people who are.
        .sort((a, b) => {
          if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1;
          return a.displayName.localeCompare(b.displayName);
        })
    );
  }, [friends, filter, query]);

  async function submitFollow() {
    const handle = handleInput.trim().replace(/^@/, "");
    if (!handle) return;
    await presence.follow(handle);
    setHandleInput("");
  }

  async function copyHandle() {
    if (!presence.me) return;
    try {
      await navigator.clipboard?.writeText(`@${presence.me.handle}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard access is refused outright in some browsers and contexts.
      // The handle is on screen to read either way, so there is nothing to
      // recover from and nothing worth interrupting anyone over.
    }
  }

  function closeSheet() {
    setSheetFor(null);
    setConfirmBlock(false);
  }

  return (
    <div className="people-tab" role="tabpanel" aria-label="People">
      <header className="people-tab-header">
        <a className="brand" href="#top" aria-label="SoSo home">
          <span>So</span>So
        </a>
        <h1>People</h1>
        <button
          type="button"
          className={`people-add-toggle${adding ? " active" : ""}`}
          onClick={() => setAdding((v) => !v)}
          aria-expanded={adding}
          aria-label={adding ? "Close add by handle" : "Add someone by handle"}
        >
          <Icon src={adding ? ICONS.close : ICONS.personAdd} size={19} />
        </button>
      </header>

      <div className="people-tab-scroll">
        {/* Identity + the privacy switch, as one card: your handle is what
            someone needs to add you, and sharing is what they see once they
            have. Two halves of the same question, so one surface. */}
        <section className="people-you" aria-label="You">
          <div className="people-you-head">
            <Avatar name={presence.me?.displayName ?? "You"} seed={presence.me?.handle ?? "you"} size={46} />
            <div className="people-you-id">
              <strong>{presence.me?.displayName ?? "You"}</strong>
              {/* Omitted rather than shown as a placeholder when there is no
                  profile to read (demo mode never loads one — usePresence is
                  disabled there): an "@…" that never resolves reads as a
                  failed load rather than as "not applicable here". */}
              {presence.me && <span>@{presence.me.handle}</span>}
            </div>
            {presence.me && (
              <button
                type="button"
                className="people-copy"
                onClick={() => void copyHandle()}
                aria-label="Copy your handle"
              >
                <Icon src={copied ? ICONS.check : ICONS.copy} size={14} />
                {copied ? "Copied" : "Copy"}
              </button>
            )}
          </div>

          <div className="people-share">
            <div className="people-share-text">
              <strong>Share your presence</strong>
              {/* The exact scope, in the row itself rather than a tooltip: an
                  opt-in that hides what it discloses behind a hover is not
                  really opt-in. */}
              <span>
                Friends who follow you back can see you&rsquo;re online, and whether you&rsquo;re in the same
                ward — never where.
              </span>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={presence.sharing}
              aria-label="Share your presence"
              className={`people-switch${presence.sharing ? " on" : ""}`}
              onClick={() => presence.setSharing(!presence.sharing)}
              disabled={demoMode}
            >
              <span className="people-switch-knob" />
            </button>
          </div>

          <div className="people-nearby">
            <span className="people-nearby-dot" aria-hidden="true" />
            <strong>{presence.areaCount ?? "–"}</strong>
            <span>
              {presence.areaCount === 1 ? "person" : "people"} active in this area — a count only, no names
            </span>
          </div>
        </section>

        {adding && (
          <section className="people-add" aria-label="Add someone">
            <div className="people-add-row">
              <input
                value={handleInput}
                onChange={(e) => setHandleInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submitFollow();
                }}
                placeholder="their handle, e.g. golden_plum7580"
                aria-label="Add someone by their handle"
                maxLength={21}
                autoFocus
              />
              <button type="button" onClick={() => void submitFollow()} disabled={presence.busy}>
                Add
              </button>
            </div>
            <p className="people-add-hint">
              You&rsquo;ll appear in each other&rsquo;s list once they add you back — following one way shows
              nothing.
            </p>
            {presence.error && <p className="people-error">{presence.error}</p>}
          </section>
        )}

        {demoMode ? (
          <p className="people-empty">Demo mode has nobody else to see — connect a backend.</p>
        ) : (
          <>
            <div className="people-filters" role="tablist" aria-label="Filter friends">
              {(
                [
                  ["all", "Friends"],
                  ["online", "Online"],
                  ["close", "Close"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={filter === key}
                  className={`people-filter${filter === key ? " active" : ""}`}
                  onClick={() => setFilter(key)}
                >
                  <strong>{counts[key]}</strong>
                  <span>{label}</span>
                </button>
              ))}
            </div>

            {friends.length > 0 && (
              <div className="people-search">
                <Icon src={ICONS.search} size={15} />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search"
                  aria-label="Search friends"
                  type="search"
                />
              </div>
            )}

            {friends.length === 0 ? (
              <div className="people-blank">
                <Icon src={ICONS.people} size={30} />
                <strong>No friends yet</strong>
                <p>Add someone by their handle. Once they add you back, you&rsquo;ll see each other here.</p>
                <button type="button" className="people-blank-action" onClick={() => setAdding(true)}>
                  Add by handle
                </button>
              </div>
            ) : visible.length === 0 ? (
              <p className="people-empty">
                {query.trim()
                  ? `Nobody matching “${query.trim()}”.`
                  : filter === "online"
                    ? "Nobody's online right now."
                    : "You haven't marked anyone as a close friend yet."}
              </p>
            ) : (
              <ul className="people-list">
                {visible.map((friend) => {
                  const status = statusOf(friend, nowSeconds);
                  return (
                    <li key={friend.id} className="people-row">
                      <Avatar
                        name={friend.displayName}
                        seed={friend.handle}
                        size={44}
                        online={friend.isOnline}
                      />
                      <div className="people-row-main">
                        <span className="people-row-name">{friend.displayName}</span>
                        <span className="people-row-handle">@{friend.handle}</span>
                        {status && (
                          <span className={`people-row-status${friend.isOnline ? " online" : ""}`}>
                            {status}
                          </span>
                        )}
                      </div>
                      {/* The primary action on a friend row, so it is a
                          labelled button rather than an item buried in the
                          "⋯" sheet: messaging someone is the thing you
                          most often came here to do. */}
                      <button
                        type="button"
                        className="people-message"
                        onClick={() => onMessage(friend.id)}
                        aria-label={`Message ${friend.displayName}`}
                      >
                        <Icon src={ICONS.send} size={15} />
                        Message
                      </button>
                      <button
                        type="button"
                        className={`people-star${friend.tier === "close" ? " active" : ""}`}
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
                        <Icon src={friend.tier === "close" ? ICONS.starFilled : ICONS.star} size={17} />
                      </button>
                      <button
                        type="button"
                        className="people-row-more"
                        onClick={() => setSheetFor(friend)}
                        aria-label={`More options for ${friend.displayName}`}
                      >
                        <Icon src={ICONS.more} size={17} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </div>

      {/* Portalled for the same reason ChatPanel's action sheet is:
          .people-tab is a fixed, z-indexed element, which makes it a
          stacking context its own children can never escape — including
          the floating .tab-bar that would otherwise sit on top of this. */}
      {sheetFor &&
        createPortal(
          <div
            className="people-sheet"
            role="dialog"
            aria-modal="true"
            aria-label="Friend options"
            onClick={closeSheet}
          >
            <div className="people-sheet-scrim" />
            <div className="people-sheet-panel" onClick={(e) => e.stopPropagation()}>
              <div className="people-sheet-head">
                <Avatar name={sheetFor.displayName} seed={sheetFor.handle} size={40} />
                <div>
                  <strong>{sheetFor.displayName}</strong>
                  <span>@{sheetFor.handle}</span>
                </div>
              </div>

              {confirmBlock ? (
                <>
                  <p className="people-sheet-warning">
                    Blocking hides your posts from {sheetFor.displayName} and theirs from you, both ways, and
                    removes the follow. You can undo it, but they will not be told either way.
                  </p>
                  <button
                    type="button"
                    className="people-sheet-row destructive"
                    onClick={() => {
                      void presence.block(sheetFor.id);
                      closeSheet();
                    }}
                  >
                    Yes, block {sheetFor.displayName}
                  </button>
                  <button type="button" className="people-sheet-row" onClick={() => setConfirmBlock(false)}>
                    Back
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="people-sheet-row"
                    onClick={() => {
                      void presence.unfollow(sheetFor.id);
                      closeSheet();
                    }}
                  >
                    <Icon src={ICONS.personRemove} size={18} />
                    Remove friend
                  </button>
                  <button
                    type="button"
                    className="people-sheet-row destructive"
                    onClick={() => setConfirmBlock(true)}
                  >
                    <Icon src={ICONS.block} size={18} />
                    Block
                  </button>
                  <button type="button" className="people-sheet-row cancel" onClick={closeSheet}>
                    Cancel
                  </button>
                </>
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
