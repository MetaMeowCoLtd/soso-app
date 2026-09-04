"use client";

import { useEffect, useRef, useState } from "react";
import { ERROR_MESSAGES_EN, formatAgo, type ChatMessage, type SosoGateway } from "soso-core";

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
 * authenticated read of every row.
 */

interface ChatPanelProps {
  gateway: SosoGateway;
  demoMode: boolean;
}

export default function ChatPanel({ gateway, demoMode }: ChatPanelProps) {
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
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages]);

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
    <div className="chat-tab" role="tabpanel" aria-label="Chat">
      <header className="chat-tab-header">
        <a className="brand" href="#top" aria-label="SoSo home">
          <span>So</span>So
        </a>
        <h1>Chat</h1>
      </header>

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
    </div>
  );
}
