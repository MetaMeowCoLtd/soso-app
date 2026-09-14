"use client";

import { useCallback, useEffect, useState } from "react";
import { ERROR_MESSAGES_EN, type DmThread, type SosoGateway } from "soso-core";
import { Avatar } from "./Avatar";
import { Icon, ICONS } from "./Icon";
import { sharePostLink } from "./sharePostLink";

/**
 * "Share this pin" — to a conversation, or out to another app.
 *
 * One sheet for all three destinations asked for, because they are one
 * decision from the person's point of view ("who am I sending this to?")
 * even though two of them are an RPC and the third is the operating
 * system's own share sheet. Splitting them into separate entry points
 * would make the app's own conversations look like an afterthought next to
 * a generic OS button, which is backwards: sending a neighbour a pin is
 * the primary thing here.
 *
 * WHAT IS SENT
 * ---------------------------------------------------------------------
 * A reference, not a link. `sendDm`/`sendChatMessage` take the post's id
 * and the server renders a card per reader (migration 0044), which is what
 * lets a friends-only pin show as a real card to the people entitled to it
 * and as "not available" to anyone else. The one destination that gets a
 * plain URL is the OS share sheet, where there is no reader to check.
 *
 * WHY THE ROOM CAN REFUSE
 * ---------------------------------------------------------------------
 * The room is global, so the server only accepts public posts there
 * (`soso/post_not_public`). Rather than hide the row — which would leave
 * someone wondering where it went — it is offered and the refusal is shown
 * as the honest sentence it is. The check lives on the server because the
 * client does not reliably know a post's audience: `Pin` carries one, but
 * a pin reached from a deep link or a notification may not have been
 * through that path.
 */

interface SharePinSheetProps {
  gateway: SosoGateway;
  postId: string;
  /** For the text that travels with an OS share — a category name, nothing more. */
  categoryLabel: string;
  /**
   * Demo mode has a working chat room but no DM threads — see demo-gateway's
   * own note on why direct messages need a real social graph. So this hides
   * the conversation list, not the room row.
   */
  demoMode: boolean;
  onClose: () => void;
}

type Sending = { kind: "room" } | { kind: "dm"; threadId: string } | null;

export default function SharePinSheet({
  gateway,
  postId,
  categoryLabel,
  demoMode,
  onClose,
}: SharePinSheetProps) {
  const [threads, setThreads] = useState<DmThread[]>([]);
  const [loadedThreads, setLoadedThreads] = useState(false);
  const [sending, setSending] = useState<Sending>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [linkNotice, setLinkNotice] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (demoMode) {
      setLoadedThreads(true);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const rows = await gateway.listDmThreads();
        if (!cancelled) setThreads(rows);
      } catch {
        // An empty list and a failed fetch look the same here on purpose.
        // The room row and the OS share still work, and a red error over a
        // list nobody asked to see would be noise.
      } finally {
        if (!cancelled) setLoadedThreads(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [gateway, demoMode]);

  const report = useCallback((err: unknown) => {
    const code = (err as { code?: string }).code as keyof typeof ERROR_MESSAGES_EN | undefined;
    setError(
      code && code in ERROR_MESSAGES_EN ? ERROR_MESSAGES_EN[code] : ERROR_MESSAGES_EN["soso/unknown"],
    );
  }, []);

  async function shareToRoom() {
    setError(null);
    setSending({ kind: "room" });
    try {
      // No caption. Someone who wants to say something about it can say it
      // in the room afterwards — a compose step inside a share sheet is a
      // second screen for something that is meant to be one tap.
      await gateway.sendChatMessage("", null, null, postId);
      setSentTo("the chat room");
    } catch (err) {
      report(err);
    } finally {
      setSending(null);
    }
  }

  async function shareToThread(thread: DmThread) {
    setError(null);
    setSending({ kind: "dm", threadId: thread.id });
    try {
      await gateway.sendDm(thread.id, "", null, null, postId);
      setSentTo(thread.otherName);
    } catch (err) {
      report(err);
    } finally {
      setSending(null);
    }
  }

  async function shareLink() {
    setError(null);
    setLinkNotice(null);
    try {
      const outcome = await sharePostLink(postId, categoryLabel);
      if (outcome === "copied") setLinkNotice("Link copied.");
      // "shared" needs no notice — the OS sheet was the feedback. Neither
      // does "cancelled": they changed their mind, and saying so about
      // their own deliberate action would be nagging.
    } catch {
      setLinkNotice("Couldn't share that link.");
    }
  }

  if (sentTo) {
    return (
      <div className="share-sheet" role="dialog" aria-modal="true" aria-label="Shared" onClick={onClose}>
        <div className="share-sheet-scrim" />
        <div className="share-sheet-panel" onClick={(e) => e.stopPropagation()}>
          <div className="share-sheet-done">
            <Icon src={ICONS.check} size={22} />
            <strong>Sent to {sentTo}</strong>
            <button type="button" className="share-sheet-close" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="share-sheet"
      role="dialog"
      aria-modal="true"
      aria-label="Share this pin"
      onClick={onClose}
    >
      <div className="share-sheet-scrim" />
      <div className="share-sheet-panel" onClick={(e) => e.stopPropagation()}>
        <header className="share-sheet-head">
          <h2>Share this pin</h2>
          <button type="button" onClick={onClose} aria-label="Close">
            <Icon src={ICONS.close} size={18} />
          </button>
        </header>

        {error && (
          <p className="share-sheet-error" role="alert">
            {error}
          </p>
        )}

        <div className="share-sheet-list">
          <button
            type="button"
            className="share-sheet-row"
            onClick={() => void shareToRoom()}
            disabled={sending !== null}
          >
            <span className="share-sheet-room-icon" aria-hidden="true">
              <Icon src={ICONS.chat} size={18} />
            </span>
            <span className="share-sheet-row-main">
              <span className="share-sheet-row-name">Chat room</span>
              <span className="share-sheet-row-sub">Everyone nearby. Public pins only.</span>
            </span>
            {sending?.kind === "room" && <span className="share-sheet-row-busy">Sending…</span>}
          </button>

          {demoMode ? (
            <p className="share-sheet-empty">
              Direct messages need a backend and two accounts that follow each other — demo mode has
              neither. The chat room above and the link below both work.
            </p>
          ) : !loadedThreads ? (
            <p className="share-sheet-empty">Loading conversations…</p>
          ) : threads.length === 0 ? (
            <p className="share-sheet-empty">
              No conversations yet. Open a friend&rsquo;s row in Friends and choose Message to start
              one.
            </p>
          ) : (
            threads.map((thread) => (
              <button
                key={thread.id}
                type="button"
                className="share-sheet-row"
                onClick={() => void shareToThread(thread)}
                disabled={sending !== null}
              >
                <Avatar
                  name={thread.otherName}
                  seed={thread.otherHandle}
                  src={gateway.avatarUrl(thread.otherAvatarPath)}
                  size={36}
                />
                <span className="share-sheet-row-main">
                  <span className="share-sheet-row-name">{thread.otherName}</span>
                  <span className="share-sheet-row-sub">@{thread.otherHandle}</span>
                </span>
                {sending?.kind === "dm" && sending.threadId === thread.id && (
                  <span className="share-sheet-row-busy">Sending…</span>
                )}
              </button>
            ))
          )}
        </div>

        <footer className="share-sheet-foot">
          <button type="button" className="share-sheet-link" onClick={() => void shareLink()}>
            <Icon src={ICONS.share} size={17} />
            Share link&hellip;
          </button>
          {linkNotice && <span className="share-sheet-link-notice">{linkNotice}</span>}
        </footer>
      </div>
    </div>
  );
}
