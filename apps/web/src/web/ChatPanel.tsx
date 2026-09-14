"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  applyReactionToggle,
  ERROR_MESSAGES_EN,
  MESSAGE_IMAGE_MIME_TYPES,
  type CategoryConfig,
  type MessageImage,
  type ChatMessage,
  type DmThread,
  type SosoGateway,
} from "soso-core";
import DmInbox from "./DmInbox";
import { MessageActionSheet, pressedBubbleRect } from "./MessageActionSheet";
import { MessageImageLightbox, MessageImageView, saveMessageImage } from "./MessageImageView";
import SharedPostCard from "./SharedPostCard";
import { useImageAttachment } from "./useImageAttachment";
import { useLongPress } from "./useLongPress";
import MessageReceipt, { type MessageReceiptState } from "./MessageReceipt";
import { useChatScroll } from "./useChatScroll";
import { useSwipeToReply } from "./useSwipeToReply";
import { useNowSeconds } from "./hooks";
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
 *
 * Reply alone also has its own, faster path: drag any bubble to the right
 * (`useSwipeToReply`) to reply to it directly, without opening the sheet
 * at all — the one action in the sheet common enough, in every chat app
 * that has both gestures, to earn a dedicated shortcut past it.
 */

interface ChatPanelProps {
  gateway: SosoGateway;
  demoMode: boolean;
  /** Boot-time config, for a shared pin's category label. */
  categories: CategoryConfig[];
  /** Opens a shared pin. page.tsx owns that surface, the same as it does for a notification deep link. */
  onOpenPost: (postId: string) => void;

  /** Null until the profile loads (and always, in demo mode) — DMs need it to derive keys. */
  myId: string | null;
  /** Opens a conversation full-screen; page.tsx owns that surface. */
  onOpenThread: (thread: DmThread) => void;
  /** Passed through to the inbox — see DmInbox's own note on why it exists. */
  refreshToken: number;
  /** Unread totals, counted in page.tsx so they survive this tab unmounting. */
  unreadDm: number;
  unreadRoom: number;
  /**
   * Reports the newest room message this view has actually shown, which is
   * what clears the room's badge. Takes that timestamp rather than clearing
   * a flag, so anything arriving between the fetch and the call is still
   * counted as unread instead of being silently swallowed.
   */
  onRoomSeen: (latestCreatedAt: string | null) => void;
  /**
   * The room's read cursor BEFORE this panel marks anything seen — the
   * thing that decides where the list opens scrolled to. See
   * `useUnreadCounts.roomSeenAt` on why it is a getter.
   */
  roomSeenAt: () => string | null;
}

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

export default function ChatPanel({
  gateway,
  demoMode,
  categories,
  onOpenPost,
  myId,
  onOpenThread,
  refreshToken,
  unreadDm,
  unreadRoom,
  onRoomSeen,
  roomSeenAt,
}: ChatPanelProps) {
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
  const fileInput = useRef<HTMLInputElement>(null);
  const attachment = useImageAttachment(gateway, { kind: "room" });
  // The URL of the image currently open full-screen, or null. Holds the URL
  // rather than the path because the thumbnail that opened it already had
  // one minted — see MessageImageLightbox.
  const [lightbox, setLightbox] = useState<{ url: string; image: MessageImage } | null>(null);

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

  /**
   * The cursor as it stood the last time the room was SHOWN.
   *
   * Read during render, never in an effect: the effect below marks the room
   * seen the moment messages are on screen, so anything reading the cursor
   * afterwards would always be told "everything is read" and the list would
   * always open at the bottom.
   *
   * Re-read when `view` flips back to the room, using React's documented
   * adjust-state-during-render pattern. Capturing it once at mount was
   * wrong in a way worth naming: after reading your unread messages and
   * flipping to Direct and back, a mount-time anchor would still point at
   * the message you had already caught up on, and the room would keep
   * re-opening part-way up its own history.
   */
  const [prevView, setPrevView] = useState(view);
  const [roomAnchorAt, setRoomAnchorAt] = useState<string | null>(() => roomSeenAt());
  if (view !== prevView) {
    setPrevView(view);
    if (view === "room") setRoomAnchorAt(roomSeenAt());
  }

  const firstUnreadId = useMemo(() => {
    if (!roomAnchorAt) return null;
    // `mine` excluded for the same reason useUnreadCounts excludes it from
    // the badge: your own message is not something to catch up on.
    return messages.find((m) => !m.mine && m.createdAt > roomAnchorAt)?.id ?? null;
  }, [messages, roomAnchorAt]);

  // `view` as the reset key: switching to Direct unmounts the room list, so
  // coming back is an open, not a continuation. See useChatScroll.
  useChatScroll(listRef, messages, firstUnreadId, view);

  const nowSeconds = useNowSeconds();

  /**
   * Only the newest message of MINE carries a receipt.
   *
   * A count under every message would be both noisy and redundant — reads
   * are cumulative, so the numbers would march downwards in a column and say
   * nothing the last one does not. Instagram puts a receipt in exactly one
   * place for the same reason, and it is your own last message because that
   * is the one you are waiting to hear about.
   */
  const receiptMessageId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i]!;
      if (m.mine) return m.seenBy > 0 ? m.id : null;
    }
    return null;
  }, [messages]);

  // Marks the room read up to whatever is actually rendered, and keeps doing
  // so as new messages land while you sit here — which is why it depends on
  // `messages` rather than firing once on mount. Scoped to the room view, so
  // reading DMs does not silently clear the room's badge.
  useEffect(() => {
    if (view !== "room" || messages.length === 0) return;
    const newest = messages.reduce<string | null>(
      (max, m) => (max === null || m.createdAt > max ? m.createdAt : max),
      null,
    );
    onRoomSeen(newest);
    // The SERVER's cursor, which is what feeds everyone else's "Seen by"
    // count. Separate from onRoomSeen, which moves this device's own unread
    // badge and stays in localStorage — see the gateway's own note on why
    // the two are not yet one thing.
    //
    // Failure is swallowed: a receipt that does not update is a cosmetic
    // loss, and surfacing it in the composer's error line would put a red
    // message under someone who did nothing wrong.
    void gateway.markChatRoomRead(newest).catch(() => {});
  }, [view, messages, onRoomSeen, gateway]);

  async function send() {
    const body = input.trim();
    // An image-only message is allowed (see migration 0040), so "nothing to
    // send" now means neither text NOR a finished attachment. Still blocked
    // while one is uploading: sending then would attach nothing and silently
    // drop the picture.
    if ((!body && !attachment.image) || sending || attachment.busy) return;
    setSending(true);
    setError(null);
    const replyToId = replyingTo?.id ?? null;
    try {
      const message = await gateway.sendChatMessage(body, replyToId, attachment.image);
      setInput("");
      setReplyingTo(null);
      attachment.clear();
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
          {/* Only on the side you are not looking at. A count on the view
              already open is noise: it is about to be zero, and while you
              sit there it would flicker up and straight back down on every
              arriving message. */}
          {view !== "room" && unreadRoom > 0 && (
            <span className="chat-switch-badge">{unreadRoom > 9 ? "9+" : unreadRoom}</span>
          )}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === "direct"}
          className={`chat-switch-option${view === "direct" ? " active" : ""}`}
          onClick={() => setView("direct")}
        >
          Direct
          {/* Shown even while the inbox is open, unlike the room's: this
              total is the sum of per-thread counts that only clear when you
              open each thread, so it stays truthful while you look at the
              list rather than resetting merely because you glanced at it. */}
          {unreadDm > 0 && (
            <span className="chat-switch-badge">{unreadDm > 9 ? "9+" : unreadDm}</span>
          )}
        </button>
      </div>

      {view === "direct" ? (
        <div className="chat-thread dm-inbox-scroll">
          <DmInbox
            gateway={gateway}
            myId={myId}
            demoMode={demoMode}
            onOpenThread={onOpenThread}
            refreshToken={refreshToken}
          />
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
                gateway={gateway}
                avatarSrc={gateway.avatarUrl(message.authorAvatarPath)}
                startsRun={startsRun}
                endsRun={endsRun}
                pressed={menu?.message.id === message.id}
                onOpenMenu={(rect) => setMenu({ message, rect })}
                onToggleReaction={(emoji) => void react(message, emoji)}
                onSwipeReply={() => startReply(message)}
                onOpenImage={(url, image) => setLightbox({ url, image })}
                categories={categories}
                onOpenPost={onOpenPost}
                receipt={
                  message.id === receiptMessageId ? { kind: "count", count: message.seenBy } : null
                }
                nowSeconds={nowSeconds}
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

      {(attachment.previewUrl || attachment.error) && (
        <div className="chat-attachment">
          {attachment.previewUrl && (
            <span className="chat-attachment-thumb">
              <img src={attachment.previewUrl} alt="" />
              {attachment.busy && <span className="chat-attachment-spinner" aria-label="Uploading" />}
            </span>
          )}
          <span className="chat-attachment-text">
            {attachment.error ?? (attachment.busy ? "Uploading…" : "Ready to send")}
          </span>
          <button
            type="button"
            className="chat-attachment-remove"
            onClick={attachment.clear}
            aria-label="Remove photo"
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
        {/* Hidden, driven by the button beside the input — a bare file
            input cannot be styled to match anything, and every app people
            already use presents this as an icon. */}
        <input
          ref={fileInput}
          type="file"
          accept={MESSAGE_IMAGE_MIME_TYPES.join(",")}
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) attachment.pick(file);
            // Cleared so picking the SAME file twice in a row still fires a
            // change event the second time.
            e.target.value = "";
          }}
        />
        <button
          type="button"
          className="chat-attach"
          onClick={() => fileInput.current?.click()}
          disabled={sending || attachment.busy}
          aria-label="Add a photo"
          title="Add a photo"
        >
          <Icon src={ICONS.image} size={18} />
        </button>
        <input
          ref={inputRef}
          className="chat-input"
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={
            attachment.previewUrl
              ? "Add a caption…"
              : replyingTo
                ? "Reply…"
                : demoMode
                  ? "Nobody else will see this"
                  : "Message…"
          }
          maxLength={500}
          aria-label="Message"
        />
        <button
          className="chat-send"
          type="submit"
          disabled={sending || attachment.busy || (input.trim().length === 0 && !attachment.image)}
          aria-label="Send"
        >
          <Icon src={ICONS.send} size={16} />
        </button>
      </form>

      {lightbox && (
        <MessageImageLightbox
          url={lightbox.url}
          onSave={() => saveMessageImage(gateway, lightbox.image)}
          onClose={() => setLightbox(null)}
        />
      )}

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
            rect={menu.rect}
            mine={menu.message.mine}
            bodyText={menu.message.body}
            media={
              // The same nodes the real bubble renders, so the clone cannot
              // drift from it. Not interactive here: the sheet is open over
              // it and a tap anywhere closes the sheet.
              menu.message.image ? (
                <MessageImageView gateway={gateway} image={menu.message.image} />
              ) : menu.message.sharedPost ? (
                <SharedPostCard post={menu.message.sharedPost} categories={categories} />
              ) : undefined
            }
            quotedText={
              menu.message.replyTo
                ? { authorLabel: menu.message.replyTo.authorName, text: menu.message.replyTo.body }
                : null
            }
            activeReaction={menu.message.reactions.find((r) => r.mine)?.emoji ?? null}
            onClose={() => setMenu(null)}
            onReact={(emoji) => void react(menu.message, emoji)}
            onReply={() => startReply(menu.message)}
            onCopy={() => void copy(menu.message)}
            onSave={
              menu.message.image
                ? () => {
                    const image = menu.message.image!;
                    setMenu(null);
                    // NOT `void saveMessageImage(...)`. That swallowed every
                    // failure, so a save that could not happen — an
                    // undeployed function, an expired URL, a refused
                    // download — was indistinguishable from the button
                    // doing nothing at all. The sheet closes on tap, so
                    // there is no sheet left to report into; the composer's
                    // own error line is where the person is already looking.
                    void saveMessageImage(gateway, image)
                      .then((outcome) => {
                        // "opened" means the bytes could not be read (see
                        // saveMessageImage) and the image was handed to a new
                        // tab instead. Nothing was saved, so saying nothing
                        // would leave someone hunting for a file that is not
                        // there.
                        if (outcome === "opened") {
                          setError("Opened it in a new tab — save it from there.");
                        }
                      })
                      .catch(() => {
                        setError("Couldn't save that image.");
                      });
                  }
                : undefined
            }
            primaryAction={
              menu.message.mine
                ? { label: "Delete", icon: ICONS.trash, onClick: () => void remove(menu.message.id) }
                : undefined
            }
          />,
          document.body,
        )}
    </div>
  );
}

function ChatMessageRow({
  message,
  gateway,
  avatarSrc,
  startsRun,
  endsRun,
  pressed,
  onOpenMenu,
  onToggleReaction,
  onSwipeReply,
  onOpenImage,
  categories,
  onOpenPost,
  receipt,
  nowSeconds,
}: {
  message: ChatMessage;
  /** Needed to mint a presigned URL for an attached image — see MessageImageView. */
  gateway: SosoGateway;
  /** Resolved by the caller — see `SosoGateway.avatarUrl` on why a path is not a URL. */
  avatarSrc: string | null;
  startsRun: boolean;
  endsRun: boolean;
  /** This is the message the open action sheet is showing a copy of — hide the original so it isn't drawn twice. */
  pressed: boolean;
  onOpenMenu: (rect: DOMRect) => void;
  onToggleReaction: (emoji: string) => void;
  onSwipeReply: () => void;
  onOpenImage: (url: string, image: MessageImage) => void;
  categories: CategoryConfig[];
  onOpenPost: (postId: string) => void;
  /** Non-null on the one message that carries a read receipt, null on the rest. */
  receipt: MessageReceiptState | null;
  nowSeconds: number;
}) {
  const bubbleRef = useRef<HTMLDivElement>(null);
  // What actually moves during a drag — see the JSX below for why this is
  // a level below `bubbleRef` rather than the same node: it wraps the
  // bubble AND its reaction pills, so a reaction rides along with the text
  // it's attached to instead of being left behind mid-swipe. `bubbleRef`
  // stays scoped to the bubble alone because openMenu's rect is meant to
  // frame exactly the bubble the action sheet is about to clone, not the
  // reactions sitting below it.
  const swipeTrackRef = useRef<HTMLDivElement>(null);

  function openMenu() {
    // pressedBubbleRect, not getBoundingClientRect — the bubble is still
    // held down here, so it's mid-`:active` scale. See that function's own
    // comment for what measuring the scaled box did to the clone's text.
    const bubble = bubbleRef.current;
    if (!bubble) return;
    // A short tick of haptic feedback, the same confirmation a native
    // long-press gives. Absent on iOS Safari and desktop, which is why it
    // is optional-called rather than relied on.
    navigator.vibrate?.(8);
    onOpenMenu(pressedBubbleRect(bubble));
  }

  const longPress = useLongPress(openMenu);
  // Same element, two independent gestures — see useSwipeToReply's own doc
  // comment on why a long press and a reply-swipe never actually race each
  // other despite sharing the bubble. The hook's touch/mouse handlers below
  // still go on the bubble itself (bubbleHandlers); only the node it moves
  // (swipeTrackRef) differs from the node it reads gestures from.
  const swipe = useSwipeToReply(swipeTrackRef, onSwipeReply);
  const author = message.authorName || message.authorHandle;

  // Merges both hooks' handlers onto the one element they share. Each event
  // name here belongs to both gestures, so both get a look at every event —
  // there is no shared state between the two hooks for this to corrupt.
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
      // How useChatScroll finds the message to open the conversation at.
      // An attribute rather than a ref per row: the hook needs to look up
      // ONE row out of a list it does not own, and threading a ref callback
      // through every row to build a map would be more machinery for the
      // same single querySelector.
      data-mid={message.id}
    >
      {!message.mine && (
        // Only on the last bubble of a run, so a burst of messages from
        // one person reads as one block instead of a column of repeated
        // avatars. The empty div still holds the indent for the others.
        <div className="chat-row-avatar" aria-hidden="true">
          {endsRun && (
            <>
              {initialsOf(author)}
              {/* Layered over the initials rather than replacing them, the
                  same way Avatar does it — the coloured disc is what shows
                  while this loads, and what stays if it never does. */}
              {avatarSrc && <img src={avatarSrc} alt="" fetchPriority="low" decoding="async" />}
            </>
          )}
        </div>
      )}

      <div className="chat-row-stack">
        {startsRun && !message.mine && <span className="chat-row-author">{author}</span>}

        <div className="chat-row-bubble-line">
          {/* The drag zone is the positioning root for the reply
              indicator (`right: 100%`, see globals.css) — it, not the row,
              because the row's own layout differs between "mine" (row-
              reverse) and "theirs", while the indicator's job is always
              simply "just left of this bubble's own box", regardless.
              It also never moves itself — see useSwipeToReply's own doc
              comment on why the indicator is positioned off this
              untransformed box rather than the swipe track's moving one. */}
          <div className="chat-bubble-drag-zone">
            <span ref={swipe.indicatorRef} className="chat-swipe-indicator" aria-hidden="true">
              <Icon src={ICONS.reply} size={16} />
            </span>
            {/* Everything that should slide together during a drag —
                the bubble AND its reactions — lives inside this one node,
                since useSwipeToReply sets `transform` on whatever ref it's
                given: nesting the reactions here rather than leaving them
                as a sibling of chat-row-bubble-line is what makes them
                move with the text instead of being left stranded mid-swipe.
                It also fixes a stacking bug that has nothing to do with
                motion: `.chat-bubble-drag-zone` is `position:relative` for
                the indicator above, which makes ITS whole subtree paint
                after any plain, non-positioned box elsewhere in the list —
                including, previously, another message's reaction pills.
                Reactions living outside any drag-zone were exactly that
                kind of plain box, so a neighboring bubble could paint over
                them regardless of which message came first on screen.
                Nested inside this drag-zone now, they paint as part of the
                same positioned subtree as their own bubble, in the same
                correct top-to-bottom order as everything else. */}
            <div ref={swipeTrackRef} className="chat-bubble-swipe-track">
              <div
                ref={bubbleRef}
                className={`chat-bubble${
                  (message.image || message.sharedPost) && !message.body
                    ? " chat-bubble-image-only"
                    : ""
                }`}
                {...bubbleHandlers}
              >
                {message.replyTo && (
                  <div className="chat-bubble-quote">
                    <span className="chat-quote-author">{message.replyTo.authorName}</span>
                    {message.replyTo.image && (
                      <MessageImageView
                        gateway={gateway}
                        image={message.replyTo.image}
                        availableWidth={40}
                        maxHeight={40}
                      />
                    )}
                    <span className="chat-quote-body">
                      {message.replyTo.body ||
                        (message.replyTo.image ? "Photo" : message.replyTo.hasPost ? "Pin" : "")}
                    </span>
                  </div>
                )}
                {message.image && (
                  <MessageImageView
                    gateway={gateway}
                    image={message.image}
                    onOpen={onOpenImage}
                  />
                )}
                {message.sharedPost && (
                  <SharedPostCard
                    post={message.sharedPost}
                    categories={categories}
                    onOpen={onOpenPost}
                  />
                )}
                {/* Omitted entirely for an image-only message rather than
                    rendered empty — an empty span still has line-height, and
                    the gap under the picture would look like a missing
                    caption. */}
                {message.body && <span className="chat-bubble-text">{message.body}</span>}
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

          {/* Hover-only, pointer-only: the same sheet the long press
              opens, for a platform where press-and-hold is not a gesture.
              aria-hidden would be wrong (it is a real control), so it is
              hidden by CSS on touch instead. */}
          <button type="button" className="chat-row-more" onClick={openMenu} aria-label="Message actions">
            <Icon src={ICONS.more} size={14} />
          </button>
        </div>

        {/* Outside the drag zone and below the bubble line, so it sits under
            the message the way a caption does and does not slide away with a
            swipe-to-reply. The caller decides which single message gets one
            — see `receiptMessageId`. */}
        {receipt && <MessageReceipt receipt={receipt} nowSeconds={nowSeconds} />}
      </div>
    </div>
  );
}

