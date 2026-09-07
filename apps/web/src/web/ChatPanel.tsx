"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  applyReactionToggle,
  ERROR_MESSAGES_EN,
  type ChatMessage,
  type DmThread,
  type SosoGateway,
} from "soso-core";
import DmInbox from "./DmInbox";
import { useLongPress } from "./useLongPress";
import { Icon, ICONS } from "./Icon";

/**
 * The shared chat panel — its own full-screen tab, not a floating panel
 * overlaid on the map (see page.tsx's tab-bar wiring: this and Feed are
 * siblings of the map, toggled by `activeTab`).
 *
 * One global room, not scoped to an area — a deliberate departure from the
 * location-bound model the rest of this app follows; see the migration's
 * own comment for why.
 *
 * Real-time delivery follows the same signal-then-refetch contract as
 * subscribePostsChanged and subscribeFollowsChanged elsewhere in this app:
 * an event on the channel means "go reload," never a payload to trust
 * directly. Kept for consistency with those, even though nothing here is
 * audience-restricted the way posts are — RLS already allows any
 * authenticated read of every row. That subscription covers reactions as
 * well as messages (see subscribeChatMessagesChanged), so someone else's
 * reaction lands here the same way their message does.
 *
 * THE INTERACTION MODEL
 * ---------------------------------------------------------------------
 * Everything you can do to a single message — react, reply, copy, delete —
 * lives behind one press-and-hold on the message itself, rather than
 * controls sitting permanently next to every bubble. That is the
 * convention every messaging app people already use has converged on, and
 * it is the reason delete is no longer a permanent "Delete" link under
 * your own messages: a destructive action does not belong one stray tap
 * away, and a row of buttons under every bubble is what made this panel
 * read as a debug view rather than a chat.
 *
 * Desktop gets the same sheet from a right-click, plus a hover-revealed
 * "⋯" button — holding a mouse button down is not a gesture anyone
 * performs, and a feature reachable only by a gesture the platform does
 * not have is a feature that does not exist there.
 */

interface ChatPanelProps {
  gateway: SosoGateway;
  demoMode: boolean;
  /** Null until the profile loads (and always, in demo mode) — DMs need it to derive keys. */
  myId: string | null;
  /** Opens a conversation full-screen; page.tsx owns that surface. */
  onOpenThread: (thread: DmThread) => void;
}

/**
 * The emoji offered in the action sheet's quick row. Six, because that is
 * what fits across a narrow phone at a comfortable tap size, and no "+"
 * to open a full picker: this app has no emoji picker component, and a
 * button that opens nothing is worse than a shorter row.
 */
const QUICK_REACTIONS = ["❤️", "😂", "😮", "😢", "🙏", "👍"];

/** Consecutive messages from one person inside this window render as a single run. */
const GROUP_WINDOW_SECONDS = 5 * 60;

/** A silence at least this long earns a time divider between the two messages. */
const DIVIDER_GAP_SECONDS = 30 * 60;

function secondsOf(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}

function initialsOf(name: string): string {
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed[0]!.toUpperCase() : "?";
}

/**
 * A divider reads as a place in time ("Yesterday 21:40"), not as an age
 * ("14 hr ago") — it is the same job a date stamp does in every other
 * chat, and relative wording there would have every divider silently
 * drifting as the panel stays open.
 */
function dividerLabel(iso: string): string {
  const at = new Date(iso);
  const now = new Date();
  const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (at.toDateString() === now.toDateString()) return time;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (at.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;
  return `${at.toLocaleDateString([], { day: "numeric", month: "short" })} ${time}`;
}

interface OpenMenu {
  message: ChatMessage;
  /** Where the bubble was on screen when the press landed — the sheet grows out of it. */
  rect: DOMRect;
}

export default function ChatPanel({ gateway, demoMode, myId, onOpenThread }: ChatPanelProps) {
  // Two things live under one tab: the single global room this app started
  // with, and direct messages. They are the same activity from the user's
  // side ("talking to people") and splitting them into a fifth tab would
  // have made the nav bar longer to say something the segmented control
  // says in one line.
  const [view, setView] = useState<"room" | "direct">("room");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [replyingTo, setReplyingTo] = useState<ChatMessage | null>(null);
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function reload() {
    try {
      const recent = await gateway.listRecentChatMessages();
      setMessages(recent);
    } catch {
      // A failed reload leaves the previous list showing rather than
      // clearing it — stale messages are a far better failure mode here
      // than an empty panel that looks like the room went silent.
    } finally {
      setLoaded(true);
    }
  }

  useEffect(() => {
    void reload();
    const unsubscribe = gateway.subscribeChatMessagesChanged(() => void reload());
    return unsubscribe;
    // Runs once: gateway is resolved once for the whole session and never
    // changes (see resolveGateway in page.tsx).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages]);

  async function send() {
    const body = input.trim();
    if (!body || sending) return;
    setSending(true);
    setError(null);
    const replyToId = replyingTo?.id ?? null;
    try {
      const message = await gateway.sendChatMessage(body, replyToId);
      setInput("");
      setReplyingTo(null);
      // Optimistic append rather than waiting on the realtime round trip —
      // demo mode has no realtime signal at all, so without this a sent
      // message would never appear for its own sender there. The
      // subsequent reload (real backend) or next send (demo) reconciles
      // with the server's own copy either way, so a brief moment of
      // showing the locally-known version first costs nothing.
      setMessages((prev) => [...prev, message]);
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
      await gateway.deleteChatMessage(id);
    } catch {
      // A failed delete just means the message reappears on the next
      // reload — not worth a dedicated error state for an action this low
      // stakes and this easy to notice went wrong.
    }
  }

  async function react(message: ChatMessage, emoji: string) {
    setMenu(null);
    // applyReactionToggle mirrors toggle_chat_reaction's own rule exactly
    // (one reaction per person; same emoji clears, different one moves) —
    // see its comment in core for why that lives there and not here.
    setMessages((prev) =>
      prev.map((m) => (m.id === message.id ? { ...m, reactions: applyReactionToggle(m.reactions, emoji) } : m)),
    );
    try {
      await gateway.toggleChatReaction(message.id, emoji);
    } catch {
      // Unlike a failed delete, this one is worth undoing immediately: a
      // reaction that silently stuck locally but never reached the server
      // would keep showing until something else forced a refetch.
      void reload();
    }
  }

  function startReply(message: ChatMessage) {
    setMenu(null);
    setReplyingTo(message);
    inputRef.current?.focus();
  }

  async function copy(message: ChatMessage) {
    setMenu(null);
    try {
      await navigator.clipboard?.writeText(message.body);
    } catch {
      // Clipboard access is refused outright in some browsers and
      // contexts. Nothing to recover from and nothing worth interrupting
      // the conversation over — the text is still on screen to select.
    }
  }

  // Only stands in for an empty list, rather than replacing the list
  // outright in demo mode as this used to: demo chat genuinely persists
  // what you send (see demo-gateway's own comment on it being a local
  // echo, not a stub), so hiding those messages meant the one thing you
  // could do in that mode appeared to do nothing at all.
  const empty = !loaded ? (
    <p className="chat-empty">Loading…</p>
  ) : messages.length === 0 ? (
    <p className="chat-empty">
      {demoMode
        ? "Demo mode has nobody else to talk to — anything you send stays on this device."
        : "Nobody’s said anything yet — be the first."}
    </p>
  ) : null;

  return (
    <div className="chat-tab" role="tabpanel" aria-label="Chat">
      <header className="chat-tab-header">
        <a className="brand" href="#top" aria-label="SoSo home">
          <span>So</span>So
        </a>
        <h1>Chat</h1>
      </header>

      <div className="chat-switch" role="tablist" aria-label="Chat view">
        <button
          type="button"
          role="tab"
          aria-selected={view === "room"}
          className={`chat-switch-option${view === "room" ? " active" : ""}`}
          onClick={() => setView("room")}
        >
          Room
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === "direct"}
          className={`chat-switch-option${view === "direct" ? " active" : ""}`}
          onClick={() => setView("direct")}
        >
          Direct
        </button>
      </div>

      {view === "direct" ? (
        <div className="chat-thread dm-inbox-scroll">
          <DmInbox gateway={gateway} myId={myId} demoMode={demoMode} onOpenThread={onOpenThread} />
        </div>
      ) : (
      <>

      <div className="chat-thread" ref={listRef}>
        {empty}
        {messages.map((message, i) => {
          const previous = i > 0 ? messages[i - 1] : undefined;
          const next = i + 1 < messages.length ? messages[i + 1] : undefined;
          const at = secondsOf(message.createdAt);
          const sincePrevious = previous ? at - secondsOf(previous.createdAt) : Infinity;
          const untilNext = next ? secondsOf(next.createdAt) - at : Infinity;
          const showDivider = sincePrevious >= DIVIDER_GAP_SECONDS;
          const startsRun =
            showDivider || previous?.authorId !== message.authorId || sincePrevious >= GROUP_WINDOW_SECONDS;
          const endsRun =
            next?.authorId !== message.authorId ||
            untilNext >= GROUP_WINDOW_SECONDS ||
            untilNext >= DIVIDER_GAP_SECONDS;

          return (
            <Fragment key={message.id}>
              {showDivider && <div className="chat-divider">{dividerLabel(message.createdAt)}</div>}
              <ChatMessageRow
                message={message}
                startsRun={startsRun}
                endsRun={endsRun}
                pressed={menu?.message.id === message.id}
                onOpenMenu={(rect) => setMenu({ message, rect })}
                onToggleReaction={(emoji) => void react(message, emoji)}
              />
            </Fragment>
          );
        })}
      </div>

      {error && <p className="chat-error">{error}</p>}

      {replyingTo && (
        <div className="chat-reply-bar">
          <div className="chat-reply-bar-body">
            <span className="chat-reply-bar-label">
              Replying to {replyingTo.mine ? "yourself" : replyingTo.authorName || replyingTo.authorHandle}
            </span>
            <span className="chat-reply-bar-text">{replyingTo.body}</span>
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
          placeholder={replyingTo ? "Reply…" : demoMode ? "Nobody else will see this" : "Message…"}
          maxLength={500}
          aria-label="Message"
        />
        <button className="chat-send" type="submit" disabled={sending || input.trim().length === 0} aria-label="Send">
          <Icon src={ICONS.send} size={16} />
        </button>
      </form>

      {/*
        Portalled to <body> rather than rendered here. .chat-tab is
        `position:fixed; z-index:1`, which makes it a stacking context —
        so a child of it, at any z-index, still paints below the floating
        .tab-bar (z-index 6) that is .chat-tab's sibling. The sheet showed
        up dimmed underneath the tab bar until this moved out.
      */}
      </>
      )}

      {menu &&
        createPortal(
          <MessageActionSheet
            message={menu.message}
            rect={menu.rect}
            onClose={() => setMenu(null)}
            onReact={(emoji) => void react(menu.message, emoji)}
            onReply={() => startReply(menu.message)}
            onCopy={() => void copy(menu.message)}
            onDelete={() => void remove(menu.message.id)}
          />,
          document.body,
        )}
    </div>
  );
}

function ChatMessageRow({
  message,
  startsRun,
  endsRun,
  pressed,
  onOpenMenu,
  onToggleReaction,
}: {
  message: ChatMessage;
  startsRun: boolean;
  endsRun: boolean;
  /** This is the message the open action sheet is showing a copy of — hide the original so it isn't drawn twice. */
  pressed: boolean;
  onOpenMenu: (rect: DOMRect) => void;
  onToggleReaction: (emoji: string) => void;
}) {
  const bubbleRef = useRef<HTMLDivElement>(null);

  function openMenu() {
    const rect = bubbleRef.current?.getBoundingClientRect();
    if (!rect) return;
    // A short tick of haptic feedback, the same confirmation a native
    // long-press gives. Absent on iOS Safari and desktop, which is why it
    // is optional-called rather than relied on.
    navigator.vibrate?.(8);
    onOpenMenu(rect);
  }

  const { handlers } = useLongPress(openMenu);
  const author = message.authorName || message.authorHandle;

  return (
    <div
      className={`chat-row ${message.mine ? "mine" : "theirs"}${endsRun ? " run-end" : ""}${pressed ? " pressed" : ""}`}
    >
      {!message.mine && (
        // Only on the last bubble of a run, so a burst of messages from
        // one person reads as one block instead of a column of repeated
        // avatars. The empty div still holds the indent for the others.
        <div className="chat-row-avatar" aria-hidden="true">
          {endsRun ? initialsOf(author) : ""}
        </div>
      )}

      <div className="chat-row-stack">
        {startsRun && !message.mine && <span className="chat-row-author">{author}</span>}

        <div className="chat-row-bubble-line">
          <div ref={bubbleRef} className="chat-bubble" {...handlers}>
            {message.replyTo && (
              <div className="chat-bubble-quote">
                <span className="chat-quote-author">{message.replyTo.authorName}</span>
                <span className="chat-quote-body">{message.replyTo.body}</span>
              </div>
            )}
            <span className="chat-bubble-text">{message.body}</span>
          </div>

          {/* Hover-only, pointer-only: the same sheet the long press
              opens, for a platform where press-and-hold is not a gesture.
              aria-hidden would be wrong (it is a real control), so it is
              hidden by CSS on touch instead. */}
          <button type="button" className="chat-row-more" onClick={openMenu} aria-label="Message actions">
            <Icon src={ICONS.more} size={14} />
          </button>
        </div>

        {message.reactions.length > 0 && (
          <div className="chat-reactions">
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
  );
}

/**
 * The long-press sheet: quick reactions above the message, actions below
 * it, everything else dimmed — the shape iOS and every messaging app on it
 * uses, so the pressed message stays put and in context rather than being
 * replaced by a menu somewhere else on screen.
 *
 * Positioning is computed from the bubble's own rect at press time rather
 * than by portalling the live element, which keeps this a plain overlay
 * with no layout coupling to the list underneath. The clone is
 * deliberately a copy: the original stays in the scrolling list, untouched.
 */
function MessageActionSheet({
  message,
  rect,
  onClose,
  onReact,
  onReply,
  onCopy,
  onDelete,
}: {
  message: ChatMessage;
  rect: DOMRect;
  onClose: () => void;
  onReact: (emoji: string) => void;
  onReply: () => void;
  onCopy: () => void;
  onDelete: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const rowCount = message.mine ? 3 : 2;
  const viewportHeight = window.innerHeight;

  // Measurements below match the CSS; they only decide whether the whole
  // group needs nudging to stay on screen, so being a few pixels out
  // shifts the arrangement slightly rather than breaking it.
  const STRIP_HEIGHT = 54;
  const ROW_HEIGHT = 46;
  const MENU_PADDING = 12;
  const GAP = 10;
  const EDGE = 24;
  const TOP_LIMIT = 72;

  const menuHeight = rowCount * ROW_HEIGHT + MENU_PADDING;
  // A very tall message scrolls inside its own clone rather than pushing
  // the menu off screen entirely.
  const bubbleHeight = Math.min(rect.height, viewportHeight * 0.38);
  const stripTop = rect.top - GAP - STRIP_HEIGHT;
  const menuBottom = rect.top + bubbleHeight + GAP + menuHeight;

  let shift = 0;
  if (menuBottom > viewportHeight - EDGE) shift = viewportHeight - EDGE - menuBottom;
  // The top constraint wins on a conflict: losing the reaction row off the
  // top of the screen is worse than the menu running past the bottom.
  if (stripTop + shift < TOP_LIMIT) shift = TOP_LIMIT - stripTop;

  return (
    <div className="chat-sheet" role="dialog" aria-modal="true" aria-label="Message actions" onClick={onClose}>
      <div className="chat-sheet-scrim" />
      <div
        className={`chat-sheet-anchor ${message.mine ? "mine" : "theirs"}`}
        style={{ top: rect.top + shift, left: rect.left, width: rect.width }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="chat-sheet-strip">
          {QUICK_REACTIONS.map((emoji) => {
            const active = message.reactions.some((r) => r.mine && r.emoji === emoji);
            return (
              <button
                key={emoji}
                type="button"
                className={`chat-sheet-emoji${active ? " active" : ""}`}
                onClick={() => onReact(emoji)}
                aria-label={emoji}
                aria-pressed={active}
              >
                {emoji}
              </button>
            );
          })}
        </div>

        <div className="chat-sheet-clone" style={{ maxHeight: bubbleHeight }}>
          {message.replyTo && (
            <div className="chat-bubble-quote">
              <span className="chat-quote-author">{message.replyTo.authorName}</span>
              <span className="chat-quote-body">{message.replyTo.body}</span>
            </div>
          )}
          <span className="chat-bubble-text">{message.body}</span>
        </div>

        <div className="chat-sheet-menu">
          <button type="button" className="chat-sheet-row" onClick={onReply}>
            Reply
            <Icon src={ICONS.reply} size={17} />
          </button>
          <button type="button" className="chat-sheet-row" onClick={onCopy}>
            Copy
            <Icon src={ICONS.copy} size={17} />
          </button>
          {message.mine && (
            <button type="button" className="chat-sheet-row destructive" onClick={onDelete}>
              Delete
              <Icon src={ICONS.trash} size={17} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
