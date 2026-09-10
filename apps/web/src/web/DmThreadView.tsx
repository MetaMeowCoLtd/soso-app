"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  applyReactionToggle,
  ERROR_MESSAGES_EN,
  type DmMessage,
  type DmThread,
  type SosoGateway,
} from "soso-core";
import { Avatar } from "./Avatar";
import { Icon, ICONS } from "./Icon";
import { MessageActionSheet, pressedBubbleRect } from "./MessageActionSheet";
import { useLongPress } from "./useLongPress";
import { useSwipeToReply } from "./useSwipeToReply";

/**
 * One conversation.
 *
 * Structurally this is ChatPanel's message list, and it shares real code
 * with it rather than merely resembling it: the long-press sheet is the
 * same `MessageActionSheet`, the swipe-right-to-reply gesture the same
 * `useSwipeToReply` hook, and — since migration 0039 — the reaction
 * bookkeeping the same `applyReactionToggle` from core.
 *
 * That last one is new, and it is the visible end of a much larger change.
 * This component used to hold an entire decryption layer: a `decryptAll`
 * that opened every message, every reply quote and every reaction with a
 * key derived from both user ids; a `DecryptedMessage` shape where each of
 * those three could be `null` for "encrypted to a key this browser does not
 * have"; a bespoke `applyMyReaction` that existed because the room's tested
 * version could not be reused on encrypted reactions; and a `keyless` state
 * for a person who had never opened messages and so had no published key to
 * encrypt to. All of it is gone. Messages arrive readable, and the
 * "can't be read on this device" placeholder that came with the old design
 * has nothing left to describe.
 */

interface DmThreadViewProps {
  thread: DmThread;
  gateway: SosoGateway;
  /** Whose messages render as "mine" — and who a reply quote belongs to. */
  myId: string;
  onClose: () => void;
}

/**
 * Characters, matching `dm_messages.body`'s own check constraint exactly.
 *
 * It used to be a derived number: the column stored base64 ciphertext capped
 * at 6000 characters, which left 4484 bytes of plaintext after the GCM tag
 * and base64 expansion, and since one character can be four bytes in UTF-8,
 * 1000 was the largest limit that could not overflow the column. The column
 * counts real characters now, so the two are the same number for the plain
 * reason that they are the same limit.
 */
const DM_MAX_LENGTH = 1000;

const REPORT_REASONS = [
  { label: "Harassment", value: "harassment" },
  { label: "Spam", value: "spam" },
  { label: "Something else", value: "other" },
] as const;

export default function DmThreadView({ thread, gateway, myId, onClose }: DmThreadViewProps) {
  const [messages, setMessages] = useState<DmMessage[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Separate from `error`: a completed report is good news, and rendering it
  // through the error slot painted it red.
  const [notice, setNotice] = useState<string | null>(null);
  const [replyingTo, setReplyingTo] = useState<DmMessage | null>(null);
  const [menu, setMenu] = useState<{ message: DmMessage; rect: DOMRect } | null>(null);
  const [reportOpen, setReportOpen] = useState<DmMessage | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    try {
      setMessages(await gateway.listDmMessages(thread.id));
    } catch {
      // Leaves whatever was already on screen rather than clearing it —
      // the same choice ChatPanel makes, for the same reason.
    } finally {
      setLoaded(true);
    }
  }, [gateway, thread.id]);

  useEffect(() => {
    void reload();
    void gateway.markDmRead(thread.id).catch(() => {});

    // Payload-free signal, like every other subscribe* in this app. Covers
    // both dm_messages and dm_message_reactions (see
    // subscribeDmMessagesChanged's own doc comment), so someone else's
    // reaction lands here the same way their message does.
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = gateway.subscribeDmMessagesChanged(() => {
      if (debounce) return;
      debounce = setTimeout(() => {
        debounce = null;
        void reload().then(() => gateway.markDmRead(thread.id).catch(() => {}));
      }, 400);
    });

    return () => {
      if (debounce) clearTimeout(debounce);
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread.id]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages]);

  async function send() {
    const body = input.trim();
    if (!body || sending) return;
    setSending(true);
    setError(null);
    try {
      const sent = await gateway.sendDm(thread.id, body, replyingTo?.id ?? null);
      setInput("");
      setReplyingTo(null);
      // The server's own echo, appended as-is. It used to be reassembled
      // here from the plaintext we still held, because decrypting our own
      // message back out of the cipher to recover a string we never lost
      // would have been theatre — there is nothing to reassemble now.
      setMessages((prev) => [...prev, sent]);
    } catch (err) {
      const code = (err as { code?: string }).code as keyof typeof ERROR_MESSAGES_EN | undefined;
      setError(code && code in ERROR_MESSAGES_EN ? ERROR_MESSAGES_EN[code] : ERROR_MESSAGES_EN["soso/unknown"]);
    } finally {
      setSending(false);
    }
  }

  async function remove(id: string) {
    setMenu(null);
    setMessages((prev) => prev.filter((m) => m.id !== id));
    // A reply quoting it loses its quote rather than pointing at a body
    // that is gone — the same thing reply_to_id's ON DELETE SET NULL does
    // server-side, applied locally so it happens now rather than on the
    // next refetch.
    setMessages((prev) => prev.map((m) => (m.replyTo?.id === id ? { ...m, replyTo: null } : m)));
    if (replyingTo?.id === id) setReplyingTo(null);
    try {
      await gateway.deleteDmMessage(id);
    } catch {
      // Reappears on the next reload if it failed — the same low-stakes
      // handling delete gets everywhere else in this app.
    }
  }

  async function report(message: DmMessage, reason: string) {
    setReportOpen(null);
    try {
      // Still sent, even though the server can now read the row itself: this
      // records what the reporter was looking at when they complained, which
      // survives the message being deleted afterwards. See the column's own
      // comment in migration 0039.
      await gateway.reportDmMessage(message.id, reason, message.body);
      setNotice("Reported. Thanks — we'll look at it.");
    } catch {
      setError("Couldn't send that report. Try again.");
    }
  }

  async function copy(message: DmMessage) {
    setMenu(null);
    try {
      await navigator.clipboard?.writeText(message.body);
    } catch {
      // Refused in some browsers and contexts; the text is on screen anyway.
    }
  }

  async function react(message: DmMessage, emoji: string) {
    setMenu(null);

    // `applyReactionToggle` is the room's own tested function, reused rather
    // than reimplemented — it mirrors exactly what toggle_dm_reaction does
    // server-side, so there is nothing for the realtime refetch to correct
    // in the success case. DMs could not use it while reactions were
    // encrypted; see this file's own module comment.
    setMessages((prev) =>
      prev.map((m) =>
        m.id === message.id ? { ...m, reactions: applyReactionToggle(m.reactions, emoji) } : m,
      ),
    );

    try {
      await gateway.toggleDmReaction(message.id, emoji);
    } catch {
      // Unlike a failed delete, this is worth undoing immediately — a
      // reaction that silently stuck locally but never reached the server
      // would keep showing until something else forced a refetch.
      void reload();
    }
  }

  function startReply(message: DmMessage) {
    setMenu(null);
    setReplyingTo(message);
    inputRef.current?.focus();
  }

  return (
    <div className="dm-thread" role="dialog" aria-modal="true" aria-label={`Messages with ${thread.otherName}`}>
      <header className="dm-thread-head">
        <button type="button" className="dm-thread-back" onClick={onClose} aria-label="Back">
          <Icon src={ICONS.chevronLeft} size={17} />
        </button>
        <Avatar
          name={thread.otherName}
          seed={thread.otherHandle}
          src={gateway.avatarUrl(thread.otherAvatarPath)}
          size={32}
        />
        <div className="dm-thread-who">
          <strong>{thread.otherName}</strong>
          <span>@{thread.otherHandle}</span>
        </div>
      </header>

      {/* This used to promise end-to-end encryption. It is deleted rather
          than softened: migration 0039 made it untrue, and a privacy claim
          that no longer holds is worse than none. Nothing replaces it,
          because "your messages are stored on our server" is the unremarkable
          default every chat app that isn't Signal already operates under,
          and announcing it in a banner over every conversation would be
          theatre in the opposite direction. What IS still true — only the two
          of you can read a thread, and only mutual follows can start one —
          is enforced in the RPCs and RLS, and said plainly in the README. */}

      <div className="chat-thread dm-thread-messages" ref={listRef}>
        {!loaded ? (
          <p className="chat-empty">Loading…</p>
        ) : messages.length === 0 ? (
          <p className="chat-empty">No messages yet — say hello.</p>
        ) : null}

        {messages.map((message, i) => {
          const next = i + 1 < messages.length ? messages[i + 1] : undefined;
          const endsRun = next?.mine !== message.mine;
          return (
            <Fragment key={message.id}>
              <DmBubble
                message={message}
                myId={myId}
                showAvatar={endsRun && !message.mine}
                endsRun={endsRun}
                otherName={thread.otherName}
                otherAvatarSrc={gateway.avatarUrl(thread.otherAvatarPath)}
                otherHandle={thread.otherHandle}
                pressed={menu?.message.id === message.id}
                onOpenMenu={(rect) => setMenu({ message, rect })}
                onSwipeReply={() => startReply(message)}
                onToggleReaction={(emoji) => void react(message, emoji)}
              />
            </Fragment>
          );
        })}
      </div>

      {notice && <p className="dm-thread-notice-ok">{notice}</p>}
      {error && <p className="chat-error">{error}</p>}

      {replyingTo && (
        <div className="chat-reply-bar">
          <div className="chat-reply-bar-body">
            <span className="chat-reply-bar-label">
              Replying to {replyingTo.mine ? "yourself" : thread.otherName}
            </span>
            <span className="chat-reply-bar-text">
              {replyingTo.body}
            </span>
          </div>
          <button
            type="button"
            className="chat-reply-bar-cancel"
            onClick={() => setReplyingTo(null)}
            aria-label="Cancel reply"
          >
            <Icon src={ICONS.close} size={11} />
          </button>
        </div>
      )}

      <form
        className="chat-compose"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <input
          ref={inputRef}
          className="chat-input"
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={replyingTo ? "Reply…" : "Message…"}
          maxLength={DM_MAX_LENGTH}
          aria-label="Message"
        />
        <button
          className="chat-send"
          type="submit"
          disabled={sending || input.trim().length === 0}
          aria-label="Send"
        >
          <Icon src={ICONS.send} size={16} />
        </button>
      </form>

      {menu &&
        createPortal(
          <MessageActionSheet
            rect={menu.rect}
            mine={menu.message.mine}
            bodyText={menu.message.body}
            quotedText={
              menu.message.replyTo
                ? {
                    authorLabel: menu.message.replyTo.senderId === myId ? "You" : thread.otherName,
                    text: menu.message.replyTo.body,
                  }
                : null
            }
            activeReaction={menu.message.reactions.find((r) => r.mine)?.emoji ?? null}
            onClose={() => setMenu(null)}
            onReact={(emoji) => void react(menu.message, emoji)}
            onReply={() => startReply(menu.message)}
            onCopy={() => void copy(menu.message)}
            primaryAction={
              menu.message.mine
                ? { label: "Unsend for everyone", icon: ICONS.trash, onClick: () => void remove(menu.message.id) }
                : { label: "Report", icon: ICONS.block, onClick: () => setReportOpen(menu.message) }
            }
          />,
          document.body,
        )}

      {/* The report reason picker stays its own, separate bottom sheet
          rather than a second view inside MessageActionSheet — the shared
          sheet is deliberately single-view (see its own module comment),
          and reporting's disclose-what-you-saw consent step is specific
          enough to DMs that folding it into the shared component would be
          bending a shared piece of UI to fit one caller. */}
      {reportOpen &&
        createPortal(
          <div className="people-sheet" role="dialog" aria-modal="true" aria-label="Report message" onClick={() => setReportOpen(null)}>
            <div className="people-sheet-scrim" />
            <div className="people-sheet-panel" onClick={(e) => e.stopPropagation()}>
              <p className="people-sheet-warning">
                Reporting sends this message&rsquo;s text to moderators. It has to: the server cannot
                read your conversation, so nothing reaches them unless you send it.
              </p>
              {REPORT_REASONS.map((reason) => (
                <button
                  key={reason.value}
                  type="button"
                  className="people-sheet-row"
                  onClick={() => void report(reportOpen, reason.value)}
                >
                  {reason.label}
                </button>
              ))}
              <button type="button" className="people-sheet-row cancel" onClick={() => setReportOpen(null)}>
                Cancel
              </button>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

function DmBubble({
  message,
  myId,
  showAvatar,
  endsRun,
  otherName,
  otherHandle,
  otherAvatarSrc,
  pressed,
  onOpenMenu,
  onSwipeReply,
  onToggleReaction,
}: {
  message: DmMessage;
  /** Only used to label a reply quote as yours or theirs. */
  myId: string;
  showAvatar: boolean;
  endsRun: boolean;
  otherName: string;
  otherHandle: string;
  /**
   * Already resolved to a URL by the caller, which has the gateway; a
   * stored `AvatarPath` would be useless here. Every bubble in a thread
   * shows the same person, so this is passed down rather than looked up
   * per row.
   */
  otherAvatarSrc: string | null;
  pressed: boolean;
  onOpenMenu: (rect: DOMRect) => void;
  onSwipeReply: () => void;
  onToggleReaction: (emoji: string) => void;
}) {
  const bubbleRef = useRef<HTMLDivElement>(null);
  // The node useSwipeToReply actually moves — see ChatPanel's own
  // ChatMessageRow (the room's twin of this component) for why this is
  // one level below bubbleRef rather than the same node: it wraps the
  // bubble AND its reaction pills so a reaction rides along with the text
  // during a drag, while bubbleRef stays scoped to just the bubble for
  // openMenu's rect.
  const swipeTrackRef = useRef<HTMLDivElement>(null);

  function openMenu() {
    // pressedBubbleRect, not getBoundingClientRect — see its own comment:
    // the bubble is mid-`:active` scale at this point, and measuring that
    // shrunken box re-wrapped the clone's text.
    const bubble = bubbleRef.current;
    if (!bubble) return;
    navigator.vibrate?.(8);
    onOpenMenu(pressedBubbleRect(bubble));
  }

  const longPress = useLongPress(openMenu);
  const swipe = useSwipeToReply(swipeTrackRef, onSwipeReply);

  // Merges both hooks' handlers onto the one element they share — see
  // useSwipeToReply's own doc comment on why a long press and a reply-swipe
  // never actually race each other despite sharing the bubble.
  const bubbleHandlers = {
    onTouchStart: (e: React.TouchEvent) => {
      swipe.handlers.onTouchStart(e);
      longPress.handlers.onTouchStart(e);
    },
    onTouchMove: (e: React.TouchEvent) => {
      swipe.handlers.onTouchMove(e);
      longPress.handlers.onTouchMove(e);
    },
    onTouchEnd: () => {
      swipe.handlers.onTouchEnd();
      longPress.handlers.onTouchEnd();
    },
    onTouchCancel: () => {
      swipe.handlers.onTouchCancel();
      longPress.handlers.onTouchCancel();
    },
    onMouseDown: (e: React.MouseEvent) => {
      swipe.handlers.onMouseDown(e);
      longPress.handlers.onMouseDown(e);
    },
    onMouseUp: longPress.handlers.onMouseUp,
    onMouseLeave: longPress.handlers.onMouseLeave,
    onContextMenu: longPress.handlers.onContextMenu,
  };

  return (
    <div
      className={`chat-row ${message.mine ? "mine" : "theirs"}${endsRun ? " run-end" : ""}${pressed ? " pressed" : ""}`}
    >
      {!message.mine &&
        (showAvatar ? (
          <Avatar name={otherName} seed={otherHandle} src={otherAvatarSrc} size={26} />
        ) : (
          <div className="chat-row-avatar" aria-hidden="true" />
        ))}
      <div className="chat-row-stack">
        <div className="chat-row-bubble-line">
          <div className="chat-bubble-drag-zone">
            <span ref={swipe.indicatorRef} className="chat-swipe-indicator" aria-hidden="true">
              <Icon src={ICONS.reply} size={16} />
            </span>
            {/* Bubble + reactions share this one moving node — see
                ChatMessageRow's own comment on why (both the "reactions
                should slide with the text" fix and the "reactions were
                painting behind another bubble" stacking fix come from the
                same change: nesting them inside this positioned drag-zone
                rather than leaving them a plain sibling of it). */}
            <div ref={swipeTrackRef} className="chat-bubble-swipe-track">
              <div
                ref={bubbleRef}
                className="chat-bubble"
                {...bubbleHandlers}
              >
                {message.replyTo && (
                  <div className="chat-bubble-quote">
                    <span className="chat-quote-author">
                      {message.replyTo.senderId === myId ? "You" : otherName}
                    </span>
                    <span className="chat-quote-body">{message.replyTo.body}</span>
                  </div>
                )}
                <span className="chat-bubble-text">{message.body}</span>
              </div>

              {message.reactions.length > 0 && (
                <div className="chat-reactions">
                  {/* Identical to the room's, down to the aggregation:
                      tapping one adds, replaces or removes your own, and the
                      other side's is untouched because toggle_dm_reaction
                      only ever writes the caller's row. It used to be keyed
                      on userId with the button disabled for anyone but you,
                      because encrypted reactions could not be grouped by
                      emoji and there was nothing a tap on theirs could
                      have meant. */}
                  {message.reactions.map((reaction) => (
                    <button
                      key={reaction.emoji}
                      type="button"
                      className={`chat-reaction${reaction.mine ? " mine" : ""}`}
                      onClick={() => onToggleReaction(reaction.emoji)}
                      aria-pressed={reaction.mine}
                      aria-label={`${reaction.emoji} ${reaction.count}`}
                    >
                      <span aria-hidden="true">{reaction.emoji}</span>
                      {reaction.count > 1 && <span className="chat-reaction-count">{reaction.count}</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          <button type="button" className="chat-row-more" onClick={openMenu} aria-label="Message options">
            <Icon src={ICONS.more} size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
