"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  applyReactionToggle,
  conversationSubtitle,
  conversationTitle,
  describeThreadEvent,
  ERROR_MESSAGES_EN,
  MESSAGE_IMAGE_MIME_TYPES,
  MESSAGE_VIDEO_MIME_TYPES,
  type CategoryConfig,
  type DmReadReceipt,
  type Friend,
  type MessageMedia,
  type DmMessage,
  type DmThread,
  type SosoGateway,
} from "soso-core";
import { Avatar } from "./Avatar";
import { ConversationAvatar } from "./ConversationAvatar";
import GroupDetailsSheet from "./GroupDetailsSheet";
import { Icon, ICONS } from "./Icon";
import { MessageActionSheet, pressedBubbleRect } from "./MessageActionSheet";
import {
  attachmentWord,
  MessageMediaLightbox,
  MessageMediaView,
  saveMessageMedia,
} from "./MessageMediaView";
import SharedPostCard from "./SharedPostCard";
import { useMediaAttachment } from "./useMediaAttachment";
import { useLongPress } from "./useLongPress";
import MessageReceipt, { type MessageReceiptState } from "./MessageReceipt";
import { useChatScroll } from "./useChatScroll";
import { useSwipeToReply } from "./useSwipeToReply";
import { useNowSeconds } from "./hooks";

/**
 * One conversation.
 *
 * Structurally this is ChatPanel's message list, and it shares real code
 * with it rather than merely resembling it: the long-press sheet is the
 * same `MessageActionSheet`, the swipe-right-to-reply gesture the same
 * `useSwipeToReply` hook, and — since migration 0039 — the reaction
 * bookkeeping the same `applyReactionToggle` from core.
 *
 * IT RENDERS BOTH KINDS OF CONVERSATION. A group is a `dm_threads` row with
 * more members (migration 0047), so this is the same component with four
 * differences, each of which is a small branch rather than a parallel
 * implementation: the header names the group and opens its detail sheet, a
 * bubble carries its sender's own name and face instead of the thread's,
 * system rows ("Ana added Sam") render as a centred pill rather than a
 * bubble, and the read receipt becomes faces rather than a sentence.
 *
 * That this cost four branches rather than a second file is the whole payoff
 * of one thread table — see the migration's own header.
 *
 * The reaction sharing below is the visible end of a much larger change.
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
  /** Mutual follows, for the group detail sheet's add-people list. */
  friends: Friend[];
  /** The thread as the server now reports it, after a rename, a photo or a membership change. */
  onThreadChanged: (thread: DmThread) => void;
  /** Whose messages render as "mine" — and who a reply quote belongs to. */
  myId: string;
  /** Boot-time config, for a shared pin's category label. */
  categories: CategoryConfig[];
  /**
   * Opens a shared pin. page.tsx owns that surface for the same reason it
   * owns a notification deep link's: opening a post can move the map and
   * switch tabs, and neither is a conversation's business.
   */
  onOpenPost: (postId: string) => void;
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

export default function DmThreadView({
  thread,
  gateway,
  friends,
  myId,
  categories,
  onOpenPost,
  onThreadChanged,
  onClose,
}: DmThreadViewProps) {
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
  const fileInput = useRef<HTMLInputElement>(null);
  const attachment = useMediaAttachment(gateway, { kind: "dm", threadId: thread.id });
  const [lightbox, setLightbox] = useState<{ url: string; media: MessageMedia } | null>(null);
  /** How far each other member has read. Empty until fetched, and for anyone who never has. */
  const [readState, setReadState] = useState<DmReadReceipt[]>([]);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const isGroup = thread.kind === "group";

  const reload = useCallback(async () => {
    // Fetched alongside the messages rather than on its own schedule: the
    // other side's cursor only ever becomes interesting when something in
    // this conversation changed, and `dm_threads` is not in the realtime
    // publication anyway (only `dm_messages` is), so there is no separate
    // signal to hang it on. The practical consequence, stated rather than
    // hidden: their "Seen" appears on the next refresh here, not the instant
    // they open the thread.
    void gateway
      .dmReadState(thread.id)
      .then(setReadState)
      .catch(() => {
        // A missing receipt renders as no receipt, which is also what an
        // honestly-unread message looks like. Nothing to report.
      });
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

  /**
   * How many messages were unread when this thread opened.
   *
   * Captured in a lazy initialiser because the very first thing this view
   * does is call `markDmRead`, after which the server's count is zero and
   * the answer is gone. `thread` also gets replaced by later inbox
   * refreshes carrying the now-cleared count.
   */
  const [unreadAtOpen] = useState(() => thread.unread);

  /**
   * THE INVARIANT THIS RESTS ON: unread messages are always the TAIL of the
   * conversation. `send_dm` moves the sender's own read cursor to the
   * message it just wrote, so nothing of yours can sit after the cursor —
   * which makes the unread set exactly the last `unread` messages, all of
   * them theirs. That is what lets a plain count stand in for a timestamp
   * and saves carrying a read cursor through `list_dm_threads`.
   *
   * It goes wrong only if the count is stale in the "too small" direction —
   * messages arriving between the inbox fetch and the thread opening. The
   * cost then is landing a message or two late, not landing wrongly.
   */
  const firstUnreadId = useMemo(() => {
    if (unreadAtOpen <= 0 || messages.length === 0) return null;
    // Clamped: more unread than loaded means the oldest of them is off the
    // first page, and useChatScroll's own fallback handles that honestly.
    return messages[Math.max(0, messages.length - unreadAtOpen)]?.id ?? null;
  }, [messages, unreadAtOpen]);

  const { jumpTo } = useChatScroll(listRef, messages, firstUnreadId);
  const [flashId, setFlashId] = useState<string | null>(null);

  /**
   * Scrolls to the message a quote is quoting.
   *
   * The "not loaded" branch is the interesting one. A conversation opens with
   * only its newest messages, so a reply to something from last week points
   * at a message that is not on the page — and the honest answer is to say
   * so rather than to scroll somewhere arbitrary and let it look like the
   * wrong message was highlighted.
   */
  function jumpToReply(id: string) {
    if (!jumpTo(id)) {
      setError("That message is further back in the conversation.");
      return;
    }
    setError(null);
    setFlashId(id);
    // Cleared by id, so a second tap on a different quote mid-animation does
    // not cancel the newer highlight.
    window.setTimeout(() => setFlashId((current) => (current === id ? null : current)), 1500);
  }


  const nowSeconds = useNowSeconds();

  /**
   * Which of my messages each reader's receipt belongs under.
   *
   * Not simply my last message: if I have sent three since somebody last
   * looked, their receipt belongs under the one their cursor reached, with the
   * two they have not seen below it. That placement is the whole information
   * content of a read receipt, and it is what makes a group's faces useful —
   * five people at different depths produce five marks at different heights,
   * which is exactly the picture of "who is caught up".
   *
   * A map from message id to the readers who stopped there, so the render pass
   * is a lookup per row rather than a scan per reader per row.
   */
  const receiptsByMessage = useMemo(() => {
    const map = new Map<string, DmReadReceipt[]>();
    for (const reader of readState) {
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const m = messages[i]!;
        // Events are skipped: "Ana added Sam" is not a message anybody sent,
        // so hanging a receipt under it would attribute it to the actor.
        if (m.mine && !m.eventKind && m.createdAt <= reader.readAt) {
          const at = map.get(m.id);
          if (at) at.push(reader);
          else map.set(m.id, [reader]);
          break;
        }
      }
    }
    return map;
  }, [messages, readState]);

  async function send() {
    const body = input.trim();
    // Image-only is allowed; still blocked while one is uploading, or the
    // send would attach nothing and silently drop the picture.
    if ((!body && !attachment.media) || sending || attachment.busy) return;
    setSending(true);
    setError(null);
    try {
      const sent = await gateway.sendDm(thread.id, body, replyingTo?.id ?? null, attachment.media);
      setInput("");
      setReplyingTo(null);
      attachment.clear();
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
    <div
      className="dm-thread"
      role="dialog"
      aria-modal="true"
      aria-label={`Messages in ${conversationTitle(thread)}`}
    >
      <header className="dm-thread-head">
        <button type="button" className="dm-thread-back" onClick={onClose} aria-label="Back">
          <Icon src={ICONS.chevronLeft} size={17} />
        </button>
        {/* The whole identity block is the way into a group's settings, which
            is where every chat app puts it and therefore the only place people
            look. A direct thread has nothing behind it, so it stays inert
            rather than becoming a button that does nothing. */}
        <button
          type="button"
          className={`dm-thread-identity${isGroup ? " tappable" : ""}`}
          onClick={isGroup ? () => setDetailsOpen(true) : undefined}
          disabled={!isGroup}
          aria-label={isGroup ? "Group details" : undefined}
        >
          <ConversationAvatar thread={thread} gateway={gateway} size={32} />
          <span className="dm-thread-who">
            <strong>{conversationTitle(thread)}</strong>
            <span>{conversationSubtitle(thread)}</span>
          </span>
          {isGroup && <Icon src={ICONS.chevronLeft} size={13} className="dm-thread-chevron" />}
        </button>
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
          // "Ana added Sam" is not a message anybody sent: no author side, no
          // reactions, no reply, no long-press. It gets a centred pill and
          // breaks the run around it, which is also why this returns before
          // any of the bubble's own bookkeeping.
          if (message.eventKind) {
            const sentence = describeThreadEvent(message, myId);
            return sentence ? (
              // `data-mid` even though nothing can reply to an event: the
              // unread count includes system rows, so the message the
              // conversation opens scrolled to can BE one -- and useChatScroll
              // finds its anchor by this attribute. Without it that case falls
              // through to the hook's "not on this page" fallback and opens at
              // the bottom instead.
              <p className="chat-event" key={message.id} data-mid={message.id}>
                {sentence}
              </p>
            ) : null;
          }

          const previous = i > 0 ? messages[i - 1] : undefined;
          const next = i + 1 < messages.length ? messages[i + 1] : undefined;
          // A run ends when the next row is somebody else's — or is an event,
          // which visually separates what is above it from what is below.
          const endsRun = next?.senderId !== message.senderId || Boolean(next?.eventKind);
          // Only a group needs a name over the bubble, and only at the top of
          // a run: repeating it on every line of a five-message burst is
          // noise, and a two-person thread already names the person in its
          // header.
          const startsRun =
            previous?.senderId !== message.senderId || Boolean(previous?.eventKind);
          const readers = receiptsByMessage.get(message.id);
          return (
            <Fragment key={message.id}>
              <DmBubble
                message={message}
                myId={myId}
                gateway={gateway}
                showAvatar={endsRun && !message.mine}
                endsRun={endsRun}
                showSenderName={isGroup && startsRun && !message.mine}
                // The thread's own other-person fields, as a fallback for a
                // server that predates migration 0047 and sends no per-message
                // sender. Null on a group, where there is no such person — and
                // a group can only come from a server that has the columns.
                fallbackName={thread.otherName ?? ""}
                fallbackHandle={thread.otherHandle ?? ""}
                fallbackAvatarPath={thread.otherAvatarPath}
                pressed={menu?.message.id === message.id}
                onOpenMenu={(rect) => setMenu({ message, rect })}
                onSwipeReply={() => startReply(message)}
                onToggleReaction={(emoji) => void react(message, emoji)}
                onOpenImage={(url, media) => setLightbox({ url, media })}
                categories={categories}
                onOpenPost={onOpenPost}
                receipt={
                  !readers || readers.length === 0
                    ? null
                    : isGroup
                      ? {
                          kind: "people",
                          readers: readers.map((r) => ({
                            id: r.userId,
                            name: r.displayName,
                            handle: r.handle,
                            src: gateway.avatarUrl(r.avatarPath),
                          })),
                        }
                      : // One other person, so when they read says more than
                        // a single face would.
                        { kind: "seen-at", readAt: readers[0]!.readAt }
                }
                nowSeconds={nowSeconds}
                flash={message.id === flashId}
                onJumpToReply={message.replyTo ? () => jumpToReply(message.replyTo!.id) : null}
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
              {/* The sender's own name, which is the only workable answer in a
                  group and the same answer as before in a DM. */}
              Replying to {replyingTo.mine ? "yourself" : replyingTo.senderName || conversationTitle(thread)}
            </span>
            <span className="chat-reply-bar-text">
              {replyingTo.body || (replyingTo.media ? attachmentWord(replyingTo.media) : "")}
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

      {/* `busy` is in the condition deliberately. A video's poster does not
          exist until its frame has been grabbed, so keying this on the
          preview alone left the composer rendering nothing for the whole
          encode — while send and attach were disabled, which looked exactly
          like the app had frozen. */}
      {(attachment.previewUrl || attachment.error || attachment.busy) && (
        <div className="chat-attachment">
          {attachment.previewUrl && (
            <span className="chat-attachment-thumb">
              <img src={attachment.previewUrl} alt="" />
              {attachment.busy && <span className="chat-attachment-spinner" aria-label="Uploading" />}
            </span>
          )}
          <span className="chat-attachment-text">
            {/* One sentence, chosen in useMediaAttachment — see its own note on
                why this stopped being four copies of a ternary. */}
            {attachment.error ?? attachment.statusText}
          </span>
          <button
            type="button"
            className="chat-attachment-remove"
            onClick={attachment.clear}
            // Reachable DURING an encode as well as after it. `clear` bumps
            // the pick sequence, so an in-flight compression is abandoned
            // rather than landing later on a composer that moved on.
            aria-label="Remove attachment"
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
          ref={fileInput}
          type="file"
          // One picker for both. Splitting them into two buttons would make the
          // person categorise their own file before the app will look at it;
          // useMediaAttachment decides which pipeline to use from the type.
          accept={[...MESSAGE_IMAGE_MIME_TYPES, ...MESSAGE_VIDEO_MIME_TYPES].join(",")}
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) attachment.pick(file);
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
            attachment.previewUrl ? "Add a caption…" : replyingTo ? "Reply…" : "Message…"
          }
          maxLength={DM_MAX_LENGTH}
          aria-label="Message"
        />
        <button
          className="chat-send"
          type="submit"
          disabled={sending || attachment.busy || (input.trim().length === 0 && !attachment.media)}
          aria-label="Send"
        >
          <Icon src={ICONS.send} size={16} />
        </button>
      </form>

      {lightbox && (
        <MessageMediaLightbox
          url={lightbox.url}
          onSave={() => saveMessageMedia(gateway, lightbox.media)}
          onClose={() => setLightbox(null)}
        />
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
              menu.message.media ? (
                <MessageMediaView gateway={gateway} image={menu.message.media} />
              ) : menu.message.sharedPost ? (
                <SharedPostCard post={menu.message.sharedPost} categories={categories} />
              ) : undefined
            }
            quotedText={
              menu.message.replyTo
                ? {
                    authorLabel:
                      menu.message.replyTo.senderId === myId
                        ? "You"
                        : menu.message.replyTo.senderName || conversationTitle(thread),
                    text: menu.message.replyTo.body,
                  }
                : null
            }
            activeReaction={menu.message.reactions.find((r) => r.mine)?.emoji ?? null}
            onClose={() => setMenu(null)}
            onReact={(emoji) => void react(menu.message, emoji)}
            onReply={() => startReply(menu.message)}
            onCopy={() => void copy(menu.message)}
            onSave={
              menu.message.media
                ? () => {
                    const image = menu.message.media!;
                    setMenu(null);
                    // NOT `void saveMessageMedia(...)`. That swallowed every
                    // failure, so a save that could not happen — an
                    // undeployed function, an expired URL, a refused
                    // download — was indistinguishable from the button
                    // doing nothing at all. The sheet closes on tap, so
                    // there is no sheet left to report into; the composer's
                    // own error line is where the person is already looking.
                    void saveMessageMedia(gateway, image)
                      .then((outcome) => {
                        // "opened" means the bytes could not be read (see
                        // saveMessageMedia) and the image was handed to a new
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
                Reporting sends this message&rsquo;s text to moderators, along with a record of what
                you were looking at when you reported it.
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

      {/* Over this whole view rather than beside it, like the conversation
          itself is over the tab bar: group settings are an exclusive surface,
          not a panel on top of a conversation you can still read. */}
      {detailsOpen && isGroup && (
        <GroupDetailsSheet
          thread={thread}
          gateway={gateway}
          friends={friends}
          myId={myId}
          onChanged={onThreadChanged}
          onLeft={() => {
            // The conversation no longer exists for this account, so there is
            // nothing to return to behind the sheet.
            setDetailsOpen(false);
            onClose();
          }}
          onClose={() => {
            setDetailsOpen(false);
            // Somebody may have been added or removed while it was open, and
            // each of those wrote a system row this view has not seen.
            void reload();
          }}
        />
      )}
    </div>
  );
}

function DmBubble({
  message,
  myId,
  gateway,
  showAvatar,
  endsRun,
  showSenderName,
  fallbackName,
  fallbackHandle,
  fallbackAvatarPath,
  pressed,
  onOpenMenu,
  onSwipeReply,
  onToggleReaction,
  onOpenImage,
  categories,
  onOpenPost,
  receipt,
  nowSeconds,
  flash,
  onJumpToReply,
}: {
  message: DmMessage;
  /** Only used to label a reply quote as yours or theirs. */
  myId: string;
  /** Needed to mint a presigned URL for an attached image — see MessageMediaView. */
  gateway: SosoGateway;
  showAvatar: boolean;
  endsRun: boolean;
  /**
   * Puts the sender's name over the bubble — a group, at the top of a run.
   *
   * A two-person thread never wants it: the header already names the one
   * person whose bubbles appear on that side.
   */
  showSenderName: boolean;
  /**
   * What to show when the message carries no sender of its own.
   *
   * Only reachable against a server predating migration 0047, where a DM's
   * messages did not need to name their sender because the thread already
   * did. The fallback is that thread's other person, which in a two-person
   * conversation is exactly who any non-`mine` message is from.
   */
  fallbackName: string;
  fallbackHandle: string;
  fallbackAvatarPath: string | null;
  pressed: boolean;
  onOpenMenu: (rect: DOMRect) => void;
  onSwipeReply: () => void;
  onToggleReaction: (emoji: string) => void;
  onOpenImage: (url: string, media: MessageMedia) => void;
  categories: CategoryConfig[];
  onOpenPost: (postId: string) => void;
  /** Non-null on the one message that carries a read receipt, null on the rest. */
  receipt: MessageReceiptState | null;
  nowSeconds: number;
  /** Non-null when this row is the target of a just-tapped reply quote. */
  flash: boolean;
  /** Jumps to the message this one is replying to. Null when it has no quote. */
  onJumpToReply: (() => void) | null;
}) {
  // The sender, per message rather than per thread, which is what a group
  // needs and what the room's own ChatMessageRow has always done. The
  // fallbacks cover a pre-0047 server; see the props' own comment.
  const senderName = message.senderName || fallbackName;
  const senderHandle = message.senderHandle || fallbackHandle;
  const senderAvatarSrc = gateway.avatarUrl(message.senderAvatarPath ?? fallbackAvatarPath);

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
  /**
   * Tapping anywhere on a reply jumps to what it is replying to.
   *
   * On the whole bubble rather than only on the quote strip, because the
   * quote is a thin band at the top of the bubble and the thing people
   * actually aim at is the message. The quote stays a real <button> anyway —
   * see the JSX — so this is an extra tap target rather than the only one,
   * and a keyboard can still reach it.
   *
   * Three things have to not trigger it, and each is a real gesture on this
   * bubble rather than a hypothetical:
   *
   *   - A LONG PRESS, which opens the action sheet. `didLongPress` exists
   *     for precisely this; without it, releasing the sheet-opening press
   *     would also scroll the list out from under the sheet.
   *   - A tap on a CONTROL INSIDE the bubble: the photo, the play button on
   *     a clip, a shared pin's card, the quote itself. Those are buttons, so
   *     one `closest` call covers all of them and any added later.
   *   - A SWIPE to reply. Not checked explicitly, because a horizontal drag
   *     past the trigger distance does not produce a click on touch — and
   *     the long-press hook's own 12px drift tolerance means a drag cannot
   *     have been a press either.
   */
  function onBubbleClick(e: React.MouseEvent) {
    if (!onJumpToReply || longPress.didLongPress()) return;
    if ((e.target as HTMLElement).closest("button")) return;
    onJumpToReply();
  }

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
      className={`chat-row ${message.mine ? "mine" : "theirs"}${endsRun ? " run-end" : ""}${pressed ? " pressed" : ""}${flash ? " flash" : ""}`}
      // How useChatScroll finds the message to open the conversation at.
      // An attribute rather than a ref per row: the hook needs to look up
      // ONE row out of a list it does not own, and threading a ref callback
      // through every row to build a map would be more machinery for the
      // same single querySelector.
      data-mid={message.id}
    >
      {!message.mine &&
        (showAvatar ? (
          <Avatar name={senderName} seed={senderHandle} src={senderAvatarSrc} size={26} />
        ) : (
          <div className="chat-row-avatar" aria-hidden="true" />
        ))}
      <div className="chat-row-stack">
        {showSenderName && <span className="chat-row-author">{senderName}</span>}
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
                className={`chat-bubble${
                  (message.media || message.sharedPost) && !message.body
                    ? " chat-bubble-image-only"
                    : ""
                }${onJumpToReply ? " chat-bubble-linked" : ""}`}
                {...bubbleHandlers}
                onClick={onBubbleClick}
              >
                {message.replyTo && (
                  <button
                    type="button"
                    className="chat-bubble-quote"
                    onClick={(e) => {
                      // Stopped so the tap does not also reach the bubble,
                      // which owns the long-press and swipe gestures.
                      e.stopPropagation();
                      onJumpToReply?.();
                    }}
                    disabled={!onJumpToReply}
                    aria-label="Go to the message this replies to"
                  >
                    <span className="chat-quote-author">
                      {message.replyTo.senderId === myId
                        ? "You"
                        : message.replyTo.senderName || fallbackName}
                    </span>
                    {message.replyTo.media && (
                      <MessageMediaView
                        gateway={gateway}
                        image={message.replyTo.media}
                        availableWidth={40}
                        maxHeight={40}
                      />
                    )}
                    <span className="chat-quote-body">
                      {message.replyTo.body ||
                        (message.replyTo.media
                          ? attachmentWord(message.replyTo.media)
                          : message.replyTo.hasPost
                            ? "Pin"
                            : "")}
                    </span>
                  </button>
                )}
                {message.media && (
                  <MessageMediaView gateway={gateway} image={message.media} onOpen={onOpenImage} />
                )}
                {message.sharedPost && (
                  <SharedPostCard
                    post={message.sharedPost}
                    categories={categories}
                    onOpen={onOpenPost}
                  />
                )}
                {message.body && <span className="chat-bubble-text">{message.body}</span>}
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

        {/* Outside the drag zone and below the bubble line, so it sits under
            the message the way a caption does and does not slide away with a
            swipe-to-reply. Placed to match the room's own ChatMessageRow.
            The caller decides which messages carry one — see
            `receiptsByMessage`.

            This render was missing entirely until group chats arrived:
            migration 0045 added DM read receipts and this component computed
            one and threaded it all the way down to this prop, which nothing
            then drew. The receipt existed in the data and never on screen. */}
        {receipt && <MessageReceipt receipt={receipt} nowSeconds={nowSeconds} />}
      </div>
    </div>
  );
}
