"use client";

import { useCallback, useEffect, useState } from "react";
import { formatAgoShort, type DmThread, type SosoGateway } from "soso-core";
import { Avatar } from "./Avatar";
import { Icon, ICONS } from "./Icon";
import { ensurePublishedKey, openMessage, threadKeyFor } from "./dmCrypto";

/**
 * The direct-message inbox.
 *
 * The one structural difference from every other list in this app: the
 * server cannot supply a preview, because it holds ciphertext. So each
 * row's preview is produced here, by decrypting that thread's newest
 * message locally. A thread whose newest message this device cannot read
 * shows that plainly rather than an empty line.
 *
 * This is also where a key gets published. Mounting the inbox is the first
 * unambiguous "I intend to use messaging" moment — which is what makes a
 * published key mean that, rather than meaning "this account exists".
 * Until someone reaches here, friends see "hasn't opened messages yet" and
 * cannot send to them, which is the intended, honest state.
 */

interface DmInboxProps {
  gateway: SosoGateway;
  myId: string | null;
  demoMode: boolean;
  onOpenThread: (thread: DmThread) => void;
  /**
   * Changes whenever a conversation is closed. Reading a thread updates
   * `dm_threads`, which is deliberately NOT in the realtime publication
   * (only `dm_messages` is), so nothing would otherwise tell this list its
   * unread badge is now wrong.
   */
  refreshToken: number;
}

interface InboxRow {
  thread: DmThread;
  /** Null when there is no message yet, or none this device can read. */
  preview: string | null;
  unreadable: boolean;
}

export default function DmInbox({ gateway, myId, demoMode, onOpenThread, refreshToken }: DmInboxProps) {
  const [rows, setRows] = useState<InboxRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const nowSeconds = Math.floor(Date.now() / 1000);

  const reload = useCallback(async () => {
    if (!myId) return;
    try {
      const threads = await gateway.listDmThreads();
      const decrypted = await Promise.all(
        threads.map(async (thread): Promise<InboxRow> => {
          if (!thread.lastCiphertext || !thread.lastIv || !thread.otherKey) {
            return { thread, preview: null, unreadable: false };
          }
          const key = await threadKeyFor(thread.otherKey, myId, thread.otherId);
          const text = await openMessage(key, thread.id, {
            ciphertext: thread.lastCiphertext,
            iv: thread.lastIv,
          });
          return { thread, preview: text, unreadable: text === null };
        }),
      );
      setRows(decrypted);
    } catch {
      // Keeps whatever was on screen; a failed inbox refresh should not
      // empty an inbox that was fine a moment ago.
    } finally {
      setLoaded(true);
    }
  }, [gateway, myId]);

  useEffect(() => {
    if (demoMode) {
      setLoaded(true);
      return;
    }
    // Still waiting on the profile: stay in the loading state rather than
    // flashing "No conversations yet" at someone who has plenty.
    if (!myId) return;

    // Publish this device's public key before listing, so that by the time
    // anyone looks at their friends list this account is messageable.
    void ensurePublishedKey(gateway, myId)
      .catch(() => {})
      .then(() => reload());

    let debounce: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = gateway.subscribeDmMessagesChanged(() => {
      if (debounce) return;
      debounce = setTimeout(() => {
        debounce = null;
        void reload();
      }, 500);
    });

    return () => {
      if (debounce) clearTimeout(debounce);
      unsubscribe();
    };
  }, [gateway, myId, demoMode, reload, refreshToken]);

  if (demoMode) {
    return (
      <p className="chat-empty">
        Direct messages need a backend and two accounts that follow each other — demo mode has
        neither.
      </p>
    );
  }

  if (!loaded) return <p className="chat-empty">Loading…</p>;

  if (rows.length === 0) {
    return (
      <div className="people-blank dm-blank">
        <Icon src={ICONS.lock} size={26} />
        <strong>No conversations yet</strong>
        <p>
          Open a friend&rsquo;s row in People and choose Message. Only people you follow each other
          with can start one, and the messages are end-to-end encrypted.
        </p>
      </div>
    );
  }

  return (
    <ul className="dm-list">
      {rows.map(({ thread, preview, unreadable }) => (
        <li key={thread.id}>
          <button type="button" className="dm-row" onClick={() => onOpenThread(thread)}>
            <Avatar name={thread.otherName} seed={thread.otherHandle} size={46} />
            <span className="dm-row-main">
              <span className="dm-row-top">
                <span className="dm-row-name">{thread.otherName}</span>
                {thread.lastMessageAt && (
                  <span className="dm-row-time">
                    {formatAgoShort(Math.floor(new Date(thread.lastMessageAt).getTime() / 1000), nowSeconds)}
                  </span>
                )}
              </span>
              <span className={`dm-row-preview${thread.unread > 0 ? " unread" : ""}`}>
                {unreadable ? (
                  <em>Can&rsquo;t be read on this device</em>
                ) : preview ? (
                  <>
                    {thread.lastSenderId === myId && <span className="dm-row-you">You: </span>}
                    {preview}
                  </>
                ) : (
                  <em>No messages yet</em>
                )}
              </span>
            </span>
            {thread.unread > 0 && <span className="dm-unread">{thread.unread}</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}
