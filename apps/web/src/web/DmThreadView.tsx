"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ERROR_MESSAGES_EN, type DmThread, type SosoGateway } from "soso-core";
import { Avatar } from "./Avatar";
import { Icon, ICONS } from "./Icon";
import { MessageActionSheet } from "./MessageActionSheet";
import { ensurePublishedKey, openMessage, sealMessage, threadKeyFor } from "./dmCrypto";
import { useLongPress } from "./useLongPress";
import { useSwipeToReply } from "./useSwipeToReply";

/**
 * One end-to-end encrypted conversation.
 *
 * Structurally this is ChatPanel's message list, and as of this pass it
 * shares real code with it, not just a resemblance: the long-press sheet
 * is the same `MessageActionSheet` component both render, and the swipe-
 * right-to-reply gesture is the same `useSwipeToReply` hook. Anything the
 * room gains from here on is meant to reach DMs the same way — see
 * `MessageActionSheet`'s own module comment.
 *
 * What is NOT shared, and cannot be: everything about reading the data.
 * Nothing arriving from the server is readable until this component
 * decrypts it, and nothing leaves it unencrypted. `listDmMessages`/
 * `sendDm` never carry a plaintext body, a plaintext reply preview, or a
 * plaintext reaction — see `decryptAll` below, which is the one place all
 * three get opened, with the one key this thread has.
 *
 * THE UNREADABLE STATE IS A FIRST-CLASS ONE
 * ---------------------------------------------------------------------
 * `openMessage` returns null whenever something was encrypted to a key
 * this browser does not have — cleared storage, a different browser, the
 * other side rotating. That is not an error to swallow or to blow the
 * whole thread up over: an unreadable message, reply quote, or reaction
 * renders as an explicit placeholder, in place, and everything around it
 * keeps working.
 */

interface DmThreadViewProps {
  thread: DmThread;
  gateway: SosoGateway;
  /** Needed to derive the conversation key — it is bound to both ids. */
  myId: string;
  onClose: () => void;
}

interface DecryptedReplyPreview {
  id: string;
  /** Whether the QUOTED message was sent by the signed-in user, not the message doing the quoting. */
  mine: boolean;
  /** Null when this device cannot decrypt the quoted message. */
  text: string | null;
}

interface DecryptedReaction {
  userId: string;
  mine: boolean;
  /** Null when this device cannot decrypt it. Rendered as a generic dot rather than hidden — see DmBubble. */
  emoji: string | null;
}

interface DecryptedMessage {
  id: string;
  mine: boolean;
  createdAt: string;
  /** Null when this device cannot read it — a state, not a failure. */
  text: string | null;
  replyTo: DecryptedReplyPreview | null;
  reactions: DecryptedReaction[];
}

/**
 * Characters, not bytes — and the gap between those is why this is 1000 and
 * not something rounder. `dm_messages.ciphertext` is capped at 6000 base64
 * characters, which is 4484 bytes of plaintext once the GCM tag and base64
 * expansion are accounted for. A character can be up to 4 bytes in UTF-8, so
 * 1000 characters is the largest limit that cannot overflow the column. At
 * the old 2000 it took only ~1500 Japanese characters to get a send rejected
 * by a constraint the UI had already told the user they were within — which
 * in a Tokyo-facing app is not an edge case.
 */
const DM_MAX_LENGTH = 1000;

const REPORT_REASONS = [
  { label: "Harassment", value: "harassment" },
  { label: "Spam", value: "spam" },
  { label: "Something else", value: "other" },
] as const;

/**
 * Replaces (or removes) the signed-in user's own reaction, leaving the
 * other side's untouched. There is no aggregation to get right here the
 * way `applyReactionToggle` (the room's own version of this) has to get
 * right for the room: a DM thread has exactly two possible reactors, ever,
 * so this is a two-branch function, not a tested module in `core`.
 */
function applyMyReaction(
  reactions: DecryptedReaction[],
  myId: string,
  emoji: string | null,
): DecryptedReaction[] {
  const others = reactions.filter((r) => !r.mine);
  return emoji ? [...others, { userId: myId, mine: true, emoji }] : others;
}

export default function DmThreadView({ thread, gateway, myId, onClose }: DmThreadViewProps) {
  const [messages, setMessages] = useState<DecryptedMessage[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Separate from `error`: a completed report is good news, and rendering it
  // through the error slot painted it red.
  const [notice, setNotice] = useState<string | null>(null);
  const [replyingTo, setReplyingTo] = useState<DecryptedMessage | null>(null);
  const [menu, setMenu] = useState<{ message: DecryptedMessage; rect: DOMRect } | null>(null);
  const [reportOpen, setReportOpen] = useState<DecryptedMessage | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const keyless = thread.otherKey === null;

  const decryptAll = useCallback(
    async (
      rows: {
        id: string;
        mine: boolean;
        senderId: string;
        createdAt: string;
        ciphertext: string;
        iv: string;
        replyTo: { id: string; ciphertext: string; iv: string; senderId: string } | null;
        reactions: { userId: string; ciphertext: string; iv: string; mine: boolean }[];
      }[],
    ): Promise<DecryptedMessage[]> => {
      if (!thread.otherKey) {
        return rows.map((r) => ({
          id: r.id,
          mine: r.mine,
          createdAt: r.createdAt,
          text: null,
          replyTo: r.replyTo ? { id: r.replyTo.id, mine: r.replyTo.senderId === myId, text: null } : null,
          reactions: r.reactions.map((rx) => ({ userId: rx.userId, mine: rx.mine, emoji: null })),
        }));
      }
      const key = await threadKeyFor(thread.otherKey, myId, thread.otherId);
      return Promise.all(
        rows.map(async (r) => ({
          id: r.id,
          mine: r.mine,
          createdAt: r.createdAt,
          text: await openMessage(key, thread.id, { ciphertext: r.ciphertext, iv: r.iv }),
          replyTo: r.replyTo
            ? {
                id: r.replyTo.id,
                mine: r.replyTo.senderId === myId,
                text: await openMessage(key, thread.id, { ciphertext: r.replyTo.ciphertext, iv: r.replyTo.iv }),
              }
            : null,
          reactions: await Promise.all(
            r.reactions.map(async (rx) => ({
              userId: rx.userId,
              mine: rx.mine,
              emoji: await openMessage(key, thread.id, { ciphertext: rx.ciphertext, iv: rx.iv }),
            })),
          ),
        })),
      );
    },
    [thread.id, thread.otherKey, thread.otherId, myId],
  );

  const reload = useCallback(async () => {
    try {
      const rows = await gateway.listDmMessages(thread.id);
      setMessages(await decryptAll(rows));
    } catch {
      // Leaves whatever was already on screen rather than clearing it —
      // the same choice ChatPanel makes, for the same reason.
    } finally {
      setLoaded(true);
    }
  }, [gateway, thread.id, decryptAll]);

  useEffect(() => {
    // Both entry points into a conversation have to do this, not just the
    // inbox: without our public key published, everything sent from here is
    // undecryptable for the person receiving it.
    void ensurePublishedKey(gateway).catch(() => {});
    void reload();
    void gateway.markDmRead(thread.id).catch(() => {});

    // Payload-free signal, like every other subscribe* in this app — and
    // here it could not be anything else: the payload is ciphertext. Covers
    // both dm_messages and dm_message_reactions (see subscribeDmMessagesChanged's
    // own doc comment), so someone else's reaction lands here the same way
    // their message does.
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
    if (!body || sending || !thread.otherKey) return;
    setSending(true);
    setError(null);
    const replyTo = replyingTo;
    try {
      const key = await threadKeyFor(thread.otherKey, myId, thread.otherId);
      const sealed = await sealMessage(key, thread.id, body);
      const sent = await gateway.sendDm(thread.id, sealed.ciphertext, sealed.iv, replyTo?.id ?? null);
      setInput("");
      setReplyingTo(null);
      // Appended from what we just encrypted rather than by decrypting the
      // echo — we already hold the plaintext, and a round trip through the
      // cipher to recover a string we never lost would be theatre.
      setMessages((prev) => [
        ...prev,
        {
          id: sent.id,
          mine: true,
          createdAt: sent.createdAt,
          text: body,
          replyTo: replyTo ? { id: replyTo.id, mine: replyTo.mine, text: replyTo.text } : null,
          reactions: [],
        },
      ]);
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

  async function report(message: DecryptedMessage, reason: string) {
    setReportOpen(null);
    try {
      // The plaintext goes up because THIS client decrypted it and its
      // owner chose to disclose it. The server cannot read the message and
      // has no way to obtain it otherwise — see migration 0026 on why an
      // E2EE report is a disclosure by a participant, not an inspection.
      await gateway.reportDmMessage(message.id, reason, message.text);
      setNotice("Reported. Thanks — we'll look at it.");
    } catch {
      setError("Couldn't send that report. Try again.");
    }
  }

  async function copy(message: DecryptedMessage) {
    setMenu(null);
    if (!message.text) return;
    try {
      await navigator.clipboard?.writeText(message.text);
    } catch {
      // Refused in some browsers and contexts; the text is on screen anyway.
    }
  }

  async function react(message: DecryptedMessage, emoji: string) {
    setMenu(null);
    if (!thread.otherKey) return;
    const mine = message.reactions.find((r) => r.mine);
    const clearing = mine?.emoji === emoji;

    // Optimistic, same as the room: applyMyReaction mirrors exactly what
    // set_dm_reaction/clear_dm_reaction do server-side, so there is
    // nothing for the realtime refetch to correct in the success case.
    setMessages((prev) =>
      prev.map((m) =>
        m.id === message.id ? { ...m, reactions: applyMyReaction(m.reactions, myId, clearing ? null : emoji) } : m,
      ),
    );

    try {
      if (clearing) {
        await gateway.clearDmReaction(message.id);
      } else {
        const key = await threadKeyFor(thread.otherKey, myId, thread.otherId);
        const sealed = await sealMessage(key, thread.id, emoji);
        await gateway.setDmReaction(message.id, sealed.ciphertext, sealed.iv);
      }
    } catch {
      // Unlike a failed delete, this is worth undoing immediately — a
      // reaction that silently stuck locally but never reached the server
      // would keep showing until something else forced a refetch.
      void reload();
    }
  }

  function startReply(message: DecryptedMessage) {
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
        <Avatar name={thread.otherName} seed={thread.otherHandle} size={32} />
        <div className="dm-thread-who">
          <strong>{thread.otherName}</strong>
          <span>@{thread.otherHandle}</span>
        </div>
      </header>

      {/* Stated once, at the top of every conversation, rather than buried
          in a settings page nobody opens. It is also the honest place to
          say what is NOT covered — see the README's own section. */}
      <p className="dm-thread-notice">
        <Icon src={ICONS.lock} size={12} />
        Messages are end-to-end encrypted. Only you and {thread.otherName} can read them — this server
        stores them as ciphertext it has no key for.
      </p>

      <div className="chat-thread dm-thread-messages" ref={listRef}>
        {keyless ? (
          <p className="chat-empty">
            {thread.otherName} hasn&rsquo;t opened messages yet, so there&rsquo;s no key to encrypt to.
            Once they do, you can start the conversation.
          </p>
        ) : !loaded ? (
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
                showAvatar={endsRun && !message.mine}
                endsRun={endsRun}
                otherName={thread.otherName}
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
              {replyingTo.text ?? "Can't be read on this device"}
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
          placeholder={keyless ? "Waiting for their key…" : replyingTo ? "Reply…" : "Message…"}
          maxLength={DM_MAX_LENGTH}
          aria-label="Message"
          disabled={keyless}
        />
        <button
          className="chat-send"
          type="submit"
          disabled={sending || keyless || input.trim().length === 0}
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
            bodyText={menu.message.text ?? "Can't be read on this device"}
            quotedText={
              menu.message.replyTo
                ? {
                    authorLabel: menu.message.replyTo.mine ? "You" : thread.otherName,
                    text: menu.message.replyTo.text ?? "Can't be read on this device",
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
  showAvatar,
  endsRun,
  otherName,
  otherHandle,
  pressed,
  onOpenMenu,
  onSwipeReply,
  onToggleReaction,
}: {
  message: DecryptedMessage;
  showAvatar: boolean;
  endsRun: boolean;
  otherName: string;
  otherHandle: string;
  pressed: boolean;
  onOpenMenu: (rect: DOMRect) => void;
  onSwipeReply: () => void;
  onToggleReaction: (emoji: string) => void;
}) {
  const bubbleRef = useRef<HTMLDivElement>(null);

  function openMenu() {
    const rect = bubbleRef.current?.getBoundingClientRect();
    if (!rect) return;
    navigator.vibrate?.(8);
    onOpenMenu(rect);
  }

  const longPress = useLongPress(openMenu);
  const swipe = useSwipeToReply(bubbleRef, onSwipeReply);

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
          <Avatar name={otherName} seed={otherHandle} size={26} />
        ) : (
          <div className="chat-row-avatar" aria-hidden="true" />
        ))}
      <div className="chat-row-stack">
        <div className="chat-row-bubble-line">
          <div className="chat-bubble-drag-zone">
            <span ref={swipe.indicatorRef} className="chat-swipe-indicator" aria-hidden="true">
              <Icon src={ICONS.reply} size={16} />
            </span>
            <div
              ref={bubbleRef}
              className={`chat-bubble${message.text === null ? " unreadable" : ""}`}
              {...bubbleHandlers}
            >
              {message.replyTo && (
                <div className="chat-bubble-quote">
                  <span className="chat-quote-author">{message.replyTo.mine ? "You" : otherName}</span>
                  <span className="chat-quote-body">
                    {message.replyTo.text ?? "Can't be read on this device"}
                  </span>
                </div>
              )}
              <span className="chat-bubble-text">
                {message.text === null ? "Can't be read on this device" : message.text}
              </span>
            </div>
          </div>
          <button type="button" className="chat-row-more" onClick={openMenu} aria-label="Message options">
            <Icon src={ICONS.more} size={14} />
          </button>
        </div>

        {message.reactions.length > 0 && (
          <div className="chat-reactions">
            {message.reactions.map((reaction) => (
              <button
                key={reaction.userId}
                type="button"
                className={`chat-reaction${reaction.mine ? " mine" : ""}`}
                // Only your own reaction is yours to tap away — the other
                // side's is theirs to change, the same asymmetry the room
                // enforces server-side (toggle_chat_reaction only ever
                // touches the caller's own row) but which here is worth
                // enforcing in the UI too: there is no server call this
                // button could make on someone else's reaction that would
                // mean anything.
                disabled={!reaction.mine}
                onClick={() => reaction.emoji && onToggleReaction(reaction.emoji)}
                aria-pressed={reaction.mine}
                aria-label={reaction.emoji ?? "Reaction unavailable on this device"}
              >
                {reaction.emoji ?? "•"}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
