"use client";

import { useEffect, useRef, useState } from "react";
import { ERROR_MESSAGES_EN, formatAgo, type ChatMessage, type SosoGateway } from "soso-core";

/**
 * The shared chat panel.
 *
 * One global room, not scoped to an area — a deliberate departure from the
 * location-bound model the rest of this app follows; see the migration's
 * own comment for why. Mirrors PeoplePanel's exact minimize mechanism
 * (mounted at all times, a CSS class toggle collapses it toward the header
 * icon rather than unmounting) but is positioned on the opposite side of
 * the screen — People opens top-left specifically to stay clear of the
 * vertical rail further down the right side, and putting chat on the right
 * instead means the two panels can never overlap each other either, even
 * if both happen to be open at once.
 *
 * State is self-contained here rather than lifted into page.tsx the way
 * presence is for PeoplePanel — there is no unread-count badge on the
 * header button (a reasonable next addition, not built here: it would need
 * the message list hoisted up to be visible to the button too, which
 * wasn't asked for and adds real complexity for a feature this scope
 * didn't request).
 *
 * Real-time delivery follows the same signal-then-refetch contract as
 * subscribePostsChanged and subscribeFollowsChanged elsewhere in this app:
 * an event on the channel means "go reload," never a payload to trust
 * directly. Kept for consistency with those, even though nothing here is
 * audience-restricted the way posts are — RLS already allows any
 * authenticated read of every row.
 */

interface ChatPanelProps {
  gateway: SosoGateway;
  demoMode: boolean;
  minimized: boolean;
  onMinimize: () => void;
}

export default function ChatPanel({ gateway, demoMode, minimized, onMinimize }: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const nowSeconds = Math.floor(Date.now() / 1000);

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
    if (!minimized) listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, minimized]);

  async function send() {
    const body = input.trim();
    if (!body || sending) return;
    setSending(true);
    setError(null);
    try {
      const message = await gateway.sendChatMessage(body);
      setInput("");
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
    setMessages((prev) => prev.filter((m) => m.id !== id));
    try {
      await gateway.deleteChatMessage(id);
    } catch {
      // A failed delete just means the message reappears on the next
      // reload — not worth a dedicated error state for an action this low
      // stakes and this easy to notice went wrong.
    }
  }

  return (
    <aside
      className={`chat-frame ${minimized ? "minimized" : ""}`}
      aria-label="Chat"
      aria-hidden={minimized}
      // See PeoplePanel's identical use of this: genuinely out of the tab
      // order while minimized, not just visually hidden.
      inert={minimized || undefined}
    >
      <div className="people-frame-head">
        <span className="people-frame-title">Chat</span>
        <button
          className="people-frame-close"
          onClick={onMinimize}
          aria-label="Minimize"
          title="Minimize"
          type="button"
        >
          <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
            <rect x="1" y="5.25" width="10" height="1.5" rx=".75" fill="currentColor" />
          </svg>
        </button>
      </div>

      <div className="chat-messages" ref={listRef}>
        {demoMode ? (
          <p className="chat-empty">Demo mode has nobody else to talk to — connect a backend to share this.</p>
        ) : !loaded ? (
          <p className="chat-empty">Loading…</p>
        ) : messages.length === 0 ? (
          <p className="chat-empty">Nobody's said anything yet — be the first.</p>
        ) : (
          messages.map((m) => (
            <div key={m.id} className={`chat-message ${m.mine ? "mine" : ""}`}>
              <div className="chat-message-meta">
                <span className="chat-message-author">{m.mine ? "You" : m.authorName || m.authorHandle}</span>
                <span className="chat-message-time">{formatAgo(Math.floor(new Date(m.createdAt).getTime() / 1000), nowSeconds)}</span>
              </div>
              <span className="chat-message-body">{m.body}</span>
              {m.mine && (
                <button className="chat-message-delete" type="button" onClick={() => void remove(m.id)}>
                  Delete
                </button>
              )}
            </div>
          ))
        )}
      </div>

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
          placeholder={demoMode ? "Nobody else will see this" : "Say something…"}
          maxLength={500}
          aria-label="Message"
        />
        <button className="chat-send" type="submit" disabled={sending || input.trim().length === 0} aria-label="Send">
          <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 10h13M10 3l7 7-7 7" />
          </svg>
        </button>
      </form>
    </aside>
  );
}
