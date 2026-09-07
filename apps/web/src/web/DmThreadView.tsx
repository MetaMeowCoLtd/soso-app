"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ERROR_MESSAGES_EN, type DmThread, type SosoGateway } from "soso-core";
import { Avatar } from "./Avatar";
import { Icon, ICONS } from "./Icon";
import { ensurePublishedKey, openMessage, sealMessage, threadKeyFor } from "./dmCrypto";
import { useLongPress } from "./useLongPress";

/**
 * One end-to-end encrypted conversation.
 *
 * Structurally this is ChatPanel's message list, with one difference that
 * runs through everything: nothing arriving from the server is readable
 * until this component decrypts it, and nothing leaves it unencrypted. The
 * gateway methods behind it (`listDmMessages`, `sendDm`) do not have a
 * parameter for a body — only for bytes.
 *
 * THE UNREADABLE STATE IS A FIRST-CLASS ONE
 * ---------------------------------------------------------------------
 * `openMessage` returns null whenever a message was encrypted to a key
 * this browser does not have — cleared storage, a different browser, the
 * other side rotating. That is not an error to swallow or to blow the
 * whole thread up over: those messages render as an explicit "can't be
 * read on this device" placeholder, in place, and everything around them
 * keeps working. Any design that treats decryption failure as exceptional
 * ends up showing an empty conversation instead of an honest one.
 */

interface DmThreadViewProps {
  thread: DmThread;
  gateway: SosoGateway;
  /** Needed to derive the conversation key — it is bound to both ids. */
  myId: string;
  onClose: () => void;
}

interface DecryptedMessage {
  id: string;
  mine: boolean;
  createdAt: string;
  /** Null when this device cannot read it — a state, not a failure. */
  text: string | null;
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

export default function DmThreadView({ thread, gateway, myId, onClose }: DmThreadViewProps) {
  const [messages, setMessages] = useState<DecryptedMessage[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Separate from `error`: a completed report is good news, and rendering it
  // through the error slot painted it red.
  const [notice, setNotice] = useState<string | null>(null);
  const [sheetFor, setSheetFor] = useState<DecryptedMessage | null>(null);
  const [reporting, setReporting] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const keyless = thread.otherKey === null;

  const decryptAll = useCallback(
    async (rows: { id: string; mine: boolean; createdAt: string; ciphertext: string; iv: string }[]) => {
      if (!thread.otherKey) {
        return rows.map((r) => ({ id: r.id, mine: r.mine, createdAt: r.createdAt, text: null }));
      }
      const key = await threadKeyFor(thread.otherKey, myId, thread.otherId);
      return Promise.all(
        rows.map(async (r) => ({
          id: r.id,
          mine: r.mine,
          createdAt: r.createdAt,
          text: await openMessage(key, thread.id, { ciphertext: r.ciphertext, iv: r.iv }),
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
    // here it could not be anything else: the payload is ciphertext.
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
    try {
      const key = await threadKeyFor(thread.otherKey, myId, thread.otherId);
      const sealed = await sealMessage(key, thread.id, body);
      const sent = await gateway.sendDm(thread.id, sealed.ciphertext, sealed.iv);
      setInput("");
      // Appended from what we just encrypted rather than by decrypting the
      // echo — we already hold the plaintext, and a round trip through the
      // cipher to recover a string we never lost would be theatre.
      setMessages((prev) => [
        ...prev,
        { id: sent.id, mine: true, createdAt: sent.createdAt, text: body },
      ]);
    } catch (err) {
      const code = (err as { code?: string }).code as keyof typeof ERROR_MESSAGES_EN | undefined;
      setError(code && code in ERROR_MESSAGES_EN ? ERROR_MESSAGES_EN[code] : ERROR_MESSAGES_EN["soso/unknown"]);
    } finally {
      setSending(false);
    }
  }

  async function remove(id: string) {
    setSheetFor(null);
    setMessages((prev) => prev.filter((m) => m.id !== id));
    try {
      await gateway.deleteDmMessage(id);
    } catch {
      // Reappears on the next reload if it failed — the same low-stakes
      // handling delete gets everywhere else in this app.
    }
  }

  async function report(message: DecryptedMessage, reason: string) {
    setSheetFor(null);
    setReporting(false);
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
    setSheetFor(null);
    if (!message.text) return;
    try {
      await navigator.clipboard?.writeText(message.text);
    } catch {
      // Refused in some browsers and contexts; the text is on screen anyway.
    }
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
                pressed={sheetFor?.id === message.id}
                onOpenMenu={() => setSheetFor(message)}
              />
            </Fragment>
          );
        })}
      </div>

      {notice && <p className="dm-thread-notice-ok">{notice}</p>}
      {error && <p className="chat-error">{error}</p>}

      <form
        className="chat-compose"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <input
          className="chat-input"
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={keyless ? "Waiting for their key…" : "Message…"}
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

      {sheetFor &&
        createPortal(
          <div
            className="people-sheet"
            role="dialog"
            aria-modal="true"
            aria-label="Message options"
            onClick={() => {
              setSheetFor(null);
              setReporting(false);
            }}
          >
            <div className="people-sheet-scrim" />
            <div className="people-sheet-panel" onClick={(e) => e.stopPropagation()}>
              {reporting ? (
                <>
                  <p className="people-sheet-warning">
                    Reporting sends this message&rsquo;s text to moderators. It has to: the server
                    cannot read your conversation, so nothing reaches them unless you send it.
                  </p>
                  {REPORT_REASONS.map((reason) => (
                    <button
                      key={reason.value}
                      type="button"
                      className="people-sheet-row"
                      onClick={() => void report(sheetFor, reason.value)}
                    >
                      {reason.label}
                    </button>
                  ))}
                  <button type="button" className="people-sheet-row cancel" onClick={() => setReporting(false)}>
                    Back
                  </button>
                </>
              ) : (
                <>
                  {sheetFor.text && (
                    <button type="button" className="people-sheet-row" onClick={() => void copy(sheetFor)}>
                      <Icon src={ICONS.copy} size={18} />
                      Copy
                    </button>
                  )}
                  {sheetFor.mine ? (
                    <button
                      type="button"
                      className="people-sheet-row destructive"
                      onClick={() => void remove(sheetFor.id)}
                    >
                      <Icon src={ICONS.trash} size={18} />
                      Unsend for everyone
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="people-sheet-row destructive"
                      onClick={() => setReporting(true)}
                    >
                      <Icon src={ICONS.block} size={18} />
                      Report
                    </button>
                  )}
                  <button
                    type="button"
                    className="people-sheet-row cancel"
                    onClick={() => setSheetFor(null)}
                  >
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

function DmBubble({
  message,
  showAvatar,
  endsRun,
  otherName,
  otherHandle,
  pressed,
  onOpenMenu,
}: {
  message: DecryptedMessage;
  showAvatar: boolean;
  endsRun: boolean;
  otherName: string;
  otherHandle: string;
  pressed: boolean;
  onOpenMenu: () => void;
}) {
  const { handlers } = useLongPress(() => {
    navigator.vibrate?.(8);
    onOpenMenu();
  });

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
          <div className={`chat-bubble${message.text === null ? " unreadable" : ""}`} {...handlers}>
            <span className="chat-bubble-text">
              {message.text === null ? "Can't be read on this device" : message.text}
            </span>
          </div>
          <button type="button" className="chat-row-more" onClick={onOpenMenu} aria-label="Message options">
            <Icon src={ICONS.more} size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
