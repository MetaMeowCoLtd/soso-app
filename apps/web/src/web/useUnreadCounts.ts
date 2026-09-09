"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SosoGateway } from "soso-core";

/**
 * How many unread messages are waiting, for the Chat tab's badge.
 *
 * TWO SOURCES, TRACKED DIFFERENTLY, AND NOT BY ACCIDENT
 * ---------------------------------------------------------------------
 * Direct messages already have a real read cursor on the server:
 * `dm_thread_members.last_read_at` (migration 0026), moved by `markDmRead`
 * when a thread is opened, with `list_dm_threads` returning the resulting
 * `unread` per thread. That count is authoritative, survives a reinstall,
 * and agrees across every device you sign in on, so this hook just sums it.
 *
 * The shared room has no equivalent, because it has no membership: it is one
 * global room (migration 0015) with no per-user row to hang a cursor on.
 * Giving it a server-side one means a new table, a write every time anyone
 * glances at the tab, and a migration — and this project already has a stack
 * of migrations waiting to be applied, so a feature that only works after
 * another one is a feature that does not work today. So the room's cursor is
 * a timestamp in localStorage.
 *
 * The honest cost of that choice, stated rather than buried: the room badge
 * is PER DEVICE. Read the room on your phone and your laptop still shows
 * those messages as unread. It also resets if site data is cleared. That is
 * a real downgrade from the DM behaviour next to it, and the right fix is a
 * `chat_room_reads` table whenever the room earns one — at which point this
 * hook changes in one place and the badge stops lying on second devices.
 */

/** Where the room's per-device read cursor lives. An ISO timestamp. */
const ROOM_SEEN_KEY = "soso-room-seen";

function readRoomSeen(): string | null {
  try {
    return window.localStorage.getItem(ROOM_SEEN_KEY);
  } catch {
    // Private mode or blocked site data. Null here means "no cursor", and
    // the first fetch below plants one at now rather than counting the
    // entire history as unread.
    return null;
  }
}

function writeRoomSeen(at: string): void {
  try {
    window.localStorage.setItem(ROOM_SEEN_KEY, at);
  } catch {
    // The badge simply won't persist past a reload. Not worth surfacing.
  }
}

export interface UnreadCounts {
  /** Summed across every DM thread, from the server's own per-thread count. */
  dm: number;
  /** Messages in the shared room newer than this device's read cursor. */
  room: number;
  dmPlusRoom: number;
  /**
   * Marks the room read up to `latestCreatedAt` — the timestamp of the
   * newest message currently on screen, not `now()`. Using now() would
   * silently swallow anything that arrived in the gap between the fetch that
   * produced the list and this call.
   */
  markRoomSeen: (latestCreatedAt: string | null) => void;
  refresh: () => void;
}

/**
 * Runs in demo mode too, deliberately. Both gateways implement the two reads
 * this needs, demo's are cheap local-storage lookups, and gating it would
 * make the badge the one piece of chat UI that cannot be exercised offline.
 * Demo has no DM threads, so the DM half is simply 0 there, which is true
 * rather than merely disabled.
 */
export function useUnreadCounts(gateway: SosoGateway): UnreadCounts {
  const [dm, setDm] = useState(0);
  const [room, setRoom] = useState(0);

  // Held in a ref as well as storage so the fetch below can read the current
  // cursor without being re-created (and re-subscribed) every time it moves.
  const roomSeenRef = useRef<string | null>(null);

  const refresh = useCallback(() => {
    void (async () => {
      try {
        const threads = await gateway.listDmThreads();
        setDm(threads.reduce((sum, t) => sum + (t.unread || 0), 0));
      } catch {
        // Leaves the previous count rather than flashing 0 — a failed
        // refresh is not evidence that everything has been read.
      }

      try {
        const messages = await gateway.listRecentChatMessages();
        const newest = messages.reduce<string | null>(
          (max, m) => (max === null || m.createdAt > max ? m.createdAt : max),
          null,
        );

        if (roomSeenRef.current === null) {
          // First run on this device. Plant the cursor at the newest message
          // that already exists, so someone opening the app for the first
          // time is not told the room's entire backlog is unread.
          const seed = newest ?? new Date().toISOString();
          roomSeenRef.current = seed;
          writeRoomSeen(seed);
          setRoom(0);
          return;
        }

        const cursor = roomSeenRef.current;
        // `mine` excluded: your own message is not something you have to
        // catch up on, and the room's realtime insert fires for it too.
        setRoom(messages.filter((m) => !m.mine && m.createdAt > cursor).length);
      } catch {
        // Same reasoning as above.
      }
    })();
  }, [gateway]);

  const markRoomSeen = useCallback((latestCreatedAt: string | null) => {
    const at = latestCreatedAt ?? new Date().toISOString();
    // Never moves backwards: an older message rendering later (a paged-in
    // history load, say) must not un-read things already seen.
    if (roomSeenRef.current !== null && at <= roomSeenRef.current) {
      setRoom(0);
      return;
    }
    roomSeenRef.current = at;
    writeRoomSeen(at);
    setRoom(0);
  }, []);

  useEffect(() => {
    roomSeenRef.current = readRoomSeen();
  }, []);

  useEffect(() => {
    refresh();

    // The same two realtime channels the Chat tab itself uses, subscribed to
    // again here because this hook has to keep counting while that tab is
    // unmounted — which is exactly when a badge matters.
    const offDm = gateway.subscribeDmMessagesChanged(() => refresh());
    const offRoom = gateway.subscribeChatMessagesChanged(() => refresh());
    return () => {
      offDm();
      offRoom();
    };
  }, [gateway, refresh]);

  return { dm, room, dmPlusRoom: dm + room, markRoomSeen, refresh };
}
