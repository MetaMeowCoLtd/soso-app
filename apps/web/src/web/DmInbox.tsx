"use client";

import { useCallback, useEffect, useState } from "react";
import {
  conversationTitle,
  formatAgoShort,
  threadPreview,
  type DmThread,
  type SosoGateway,
} from "soso-core";
import { ConversationAvatar } from "./ConversationAvatar";
import { Icon, ICONS } from "./Icon";

/**
 * The message inbox: direct conversations and groups, in one list.
 *
 * ONE LIST, NOT TWO, and that follows the schema rather than merely resembling
 * it — a group is a `dm_threads` row with more members, so `list_dm_threads`
 * returns both and this renders both. Splitting them into tabs would make
 * "where is that conversation" a question with two places to look, which is
 * exactly what Instagram, LINE and Messenger all avoid.
 *
 * The per-row differences are three, and all three live in core rather than
 * here: what the row is called (`conversationTitle` — a name, or the members'
 * names for a group nobody named), what the preview line says
 * (`threadPreview`, which prefixes a group's with who spoke), and what the
 * circle shows (`ConversationAvatar`).
 *
 * Previews come straight from `list_dm_threads`. Until migration 0039 they
 * could not: the server held only ciphertext, so this component decrypted
 * every thread's newest message itself before it could draw a single row.
 */

interface DmInboxProps {
  gateway: SosoGateway;
  myId: string | null;
  demoMode: boolean;
  onOpenThread: (thread: DmThread) => void;
  /** Opens the new-group flow. Owned by page.tsx, which also owns the friends list it needs. */
  onNewGroup: () => void;
  /**
   * Changes whenever a conversation is closed. Reading a thread updates
   * `dm_thread_members`, and while that table IS in the realtime publication
   * now, a refresh triggered by your own read would be a round trip to learn
   * something this client already knows.
   */
  refreshToken: number;
}

export default function DmInbox({
  gateway,
  myId,
  demoMode,
  onOpenThread,
  onNewGroup,
  refreshToken,
}: DmInboxProps) {
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

    // Covers dm_messages, dm_message_reactions and — since migration 0047 —
    // dm_thread_members, which is what makes a group somebody just added you
    // to appear here without a reload. Nothing of yours changes when you are
    // added, so there would otherwise be no signal at all.
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
        Messages need a backend and accounts that follow each other — demo mode has neither.
      </p>
    );
  }

  return (
    <>
      {/* Above the list rather than floating over it: the list scrolls, and a
          compose button that scrolls away is one people hunt for. */}
      <div className="dm-inbox-actions">
        <button type="button" className="dm-new-group" onClick={onNewGroup}>
          <span className="dm-new-group-icon" aria-hidden="true">
            <Icon src={ICONS.people} size={15} />
          </span>
          New group
        </button>
      </div>

      {!loaded ? (
        <p className="chat-empty">Loading…</p>
      ) : rows.length === 0 ? (
        <div className="people-blank dm-blank">
          <Icon src={ICONS.lock} size={26} />
          <strong>No conversations yet</strong>
          <p>
            Open a friend&rsquo;s row in Friends and choose Message, or start a group above. Only
            people you follow each other with can be in one.
          </p>
        </div>
      ) : (
        <ul className="dm-list">
          {rows.map((thread) => {
            const title = conversationTitle(thread);
            const preview = threadPreview(thread, myId);
            return (
              <li key={thread.id}>
                <button type="button" className="dm-row" onClick={() => onOpenThread(thread)}>
                  <ConversationAvatar thread={thread} gateway={gateway} size={46} />
                  <span className="dm-row-main">
                    <span className="dm-row-top">
                      <span className="dm-row-name">{title}</span>
                      {thread.lastMessageAt && (
                        <span className="dm-row-time">
                          {formatAgoShort(
                            Math.floor(new Date(thread.lastMessageAt).getTime() / 1000),
                            nowSeconds,
                          )}
                        </span>
                      )}
                    </span>
                    <span className={`dm-row-preview${thread.unread > 0 ? " unread" : ""}`}>
                      {/* Null means nothing has been said yet, which is a
                          different row from one whose newest message happens to
                          be empty — an image-only or share-only message already
                          reads as "Photo" or "Shared a pin" by this point. */}
                      {preview ?? <em>No messages yet</em>}
                    </span>
                  </span>
                  {thread.unread > 0 && <span className="dm-unread">{thread.unread}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
