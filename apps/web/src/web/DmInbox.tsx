"use client";

import { useCallback, useEffect, useState } from "react";
import {
  conversationTitle,
  formatAgoShort,
  roomPreview,
  ROOM_NAME,
  ROOM_TAGLINE,
  threadPreview,
  type ChatMessage,
  type DmThread,
  type SosoGateway,
} from "soso-core";
import { ConversationAvatar } from "./ConversationAvatar";
import { Icon, ICONS } from "./Icon";
import { useRefetchOnForeground } from "./useRefetchOnForeground";

/**
 * The message inbox: the public room, direct conversations and groups, all in
 * one list.
 *
 * ONE LIST, NOT TWO, and that follows the schema rather than merely resembling
 * it — a group is a `dm_threads` row with more members, so `list_dm_threads`
 * returns both and this renders both. Splitting them into tabs would make
 * "where is that conversation" a question with two places to look, which is
 * exactly what Instagram, LINE and Messenger all avoid.
 *
 * THE ROOM IS PINNED AT THE TOP OF THAT SAME LIST, and it is the one row here
 * that is not a `dm_threads` row at all — `chat_messages` is its own table
 * with no membership and no thread id (migration 0015). It is rendered as a
 * conversation anyway, because that is what it is to the person reading it,
 * and a segmented control above the list asking "room or chats?" made people
 * answer a question about this app's schema before they could open anything.
 *
 * It does NOT scroll away with the list, and it is deliberately styled apart
 * from the rows under it: everything below is private to the people in it,
 * and the room is not. That visual break is load-bearing rather than
 * decorative — see `.dm-room-row`.
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
  /** Opens the public room. ChatPanel owns that view, so it owns the handler. */
  onOpenRoom: () => void;
  /**
   * The room's newest message, for its row's preview line, or null when the
   * room is empty or has not loaded yet.
   *
   * Passed in rather than fetched here: ChatPanel already holds the room's
   * messages for the room view itself, and a second fetch of the same table
   * to draw one line would be a request for something this app already has.
   */
  roomLastMessage: ChatMessage | null;
  /** The room's unread count, for its row's badge. */
  unreadRoom: number;
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
  onOpenRoom,
  roomLastMessage,
  unreadRoom,
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

  // See the hook's own doc comment: the realtime subscription above can go
  // silently stale while this tab is backgrounded, so tapping a notification
  // (or just switching back) is backstopped with an explicit refetch rather
  // than trusting the socket noticed anything changed while it was away.
  useRefetchOnForeground(reload);

  return (
    <>
      {/* FIRST, ALWAYS, AND IN DEMO MODE TOO — unlike everything below it.
          The room is the one conversation that works with no backend and no
          friends (demo-gateway keeps a local echo of it), so the "you need a
          backend for this" note belongs under this row rather than in place
          of the whole screen, which is where it used to sit. */}
      <button type="button" className="dm-row dm-room-row" onClick={onOpenRoom}>
        <span className="dm-room-icon" aria-hidden="true">
          <Icon src={ICONS.place} size={22} />
        </span>
        <span className="dm-row-main">
          <span className="dm-row-top">
            <span className="dm-row-name">
              {ROOM_NAME}
              {/* Said on the row itself, not only inside the room. This is
                  the only conversation in this list that is not private to
                  the people in it, and the moment it sits among ones that
                  ARE, the difference has to be visible without opening it. */}
              <span className="dm-room-tag">Public</span>
            </span>
            {roomLastMessage && (
              <span className="dm-row-time">
                {formatAgoShort(
                  Math.floor(new Date(roomLastMessage.createdAt).getTime() / 1000),
                  nowSeconds,
                )}
              </span>
            )}
          </span>
          <span className={`dm-row-preview${unreadRoom > 0 ? " unread" : ""}`}>
            {roomPreview(roomLastMessage, myId) ?? <em>{ROOM_TAGLINE}</em>}
          </span>
        </span>
        {unreadRoom > 0 && <span className="dm-unread">{unreadRoom}</span>}
      </button>

      {/* Above the list rather than floating over it: the list scrolls, and a
          compose button that scrolls away is one people hunt for. */}
      <div className="dm-inbox-actions">
        <button type="button" className="dm-new-group" onClick={onNewGroup} disabled={demoMode}>
          <span className="dm-new-group-icon" aria-hidden="true">
            <Icon src={ICONS.people} size={15} />
          </span>
          New group
        </button>
      </div>

      {demoMode ? (
        <p className="chat-empty">
          The room above works here. Private chats and groups need a backend and accounts that
          follow each other — demo mode has neither.
        </p>
      ) : !loaded ? (
        <p className="chat-empty">Loading…</p>
      ) : rows.length === 0 ? (
        <div className="people-blank dm-blank">
          <Icon src={ICONS.lock} size={26} />
          <strong>No private chats yet</strong>
          <p>
            The room above is open to everyone. For a private one, open a friend&rsquo;s row in
            Friends and choose Message, or start a group — only people you follow each other with
            can be in either.
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
