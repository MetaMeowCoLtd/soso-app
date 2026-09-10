"use client";

import { useCallback, useEffect, useState } from "react";
import { formatAgoShort, type DmThread, type SosoGateway } from "soso-core";
import { Avatar } from "./Avatar";
import { Icon, ICONS } from "./Icon";

/**
 * The direct-message inbox.
 *
 * Previews come straight from `list_dm_threads` now. Until migration 0039
 * they could not: the server held only ciphertext, so this component
 * decrypted every thread's newest message itself before it could draw a
 * single row, published this device's key on mount, and had a whole
 * "this device can't read that one" state for rows encrypted to a key some
 * other device had since replaced. All of that is gone — a row is a row.
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

export default function DmInbox({ gateway, myId, demoMode, onOpenThread, refreshToken }: DmInboxProps) {
  const [rows, setRows] = useState<DmThread[]>([]);
  const [loaded, setLoaded] = useState(false);
  const nowSeconds = Math.floor(Date.now() / 1000);

  const reload = useCallback(async () => {
    if (!myId) return;
    try {
      setRows(await gateway.listDmThreads());
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

    void reload();

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
          Open a friend&rsquo;s row in Friends and choose Message. Only people you follow each other
          with can start one.
        </p>
      </div>
    );
  }

  return (
    <ul className="dm-list">
      {rows.map((thread) => (
        <li key={thread.id}>
          <button type="button" className="dm-row" onClick={() => onOpenThread(thread)}>
            <Avatar
              name={thread.otherName}
              seed={thread.otherHandle}
              src={gateway.avatarUrl(thread.otherAvatarPath)}
              size={46}
            />
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
                {thread.lastBody ? (
                  <>
                    {thread.lastSenderId === myId && <span className="dm-row-you">You: </span>}
                    {thread.lastBody}
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
