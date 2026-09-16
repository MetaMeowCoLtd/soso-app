import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useRef, useState } from "react";

import type { SosoGateway } from "../core";

/**
 * Ported from apps/web/src/web/useUnreadCounts.ts. The DM half sums a real
 * server-side cursor and needs no change at all. The room half is a
 * per-device timestamp because the room has no membership to hang a server
 * cursor on (see the web version's own note on why, and its promised fix:
 * a `chat_room_reads` table whenever the room earns one) — `localStorage`
 * becomes `AsyncStorage`, which is the only mechanical change this file
 * needed.
 */

const ROOM_SEEN_KEY = "soso:room-seen:v1";

async function readRoomSeen(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(ROOM_SEEN_KEY);
  } catch {
    return null;
  }
}

async function writeRoomSeen(at: string): Promise<void> {
  try {
    await AsyncStorage.setItem(ROOM_SEEN_KEY, at);
  } catch {
    // The badge simply won't persist past a relaunch. Not worth surfacing.
  }
}

export interface UnreadCounts {
  dm: number;
  room: number;
  dmPlusRoom: number;
  markRoomSeen: (latestCreatedAt: string | null) => void;
  roomSeenAt: () => string | null;
  refresh: () => void;
}

export function useUnreadCounts(gateway: SosoGateway): UnreadCounts {
  const [dm, setDm] = useState(0);
  const [room, setRoom] = useState(0);
  const roomSeenRef = useRef<string | null>(null);

  const refresh = useCallback(() => {
    void (async () => {
      try {
        const threads = await gateway.listDmThreads();
        setDm(threads.reduce((sum, t) => sum + (t.unread || 0), 0));
      } catch {
        // Leaves the previous count rather than flashing 0.
      }

      try {
        const messages = await gateway.listRecentChatMessages();
        const newest = messages.reduce<string | null>(
          (max, m) => (max === null || m.createdAt > max ? m.createdAt : max),
          null,
        );

        if (roomSeenRef.current === null) {
          const seed = newest ?? new Date().toISOString();
          roomSeenRef.current = seed;
          void writeRoomSeen(seed);
          setRoom(0);
          return;
        }

        const cursor = roomSeenRef.current;
        setRoom(messages.filter((m) => !m.mine && m.createdAt > cursor).length);
      } catch {
        // Same reasoning as above.
      }
    })();
  }, [gateway]);

  const markRoomSeen = useCallback((latestCreatedAt: string | null) => {
    const at = latestCreatedAt ?? new Date().toISOString();
    if (roomSeenRef.current !== null && at <= roomSeenRef.current) {
      setRoom(0);
      return;
    }
    roomSeenRef.current = at;
    void writeRoomSeen(at);
    setRoom(0);
  }, []);

  useEffect(() => {
    let alive = true;
    void readRoomSeen().then((seen) => {
      if (alive) roomSeenRef.current = seen;
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    refresh();
    const offDm = gateway.subscribeDmMessagesChanged(() => refresh());
    const offRoom = gateway.subscribeChatMessagesChanged(() => refresh());
    return () => {
      offDm();
      offRoom();
    };
  }, [gateway, refresh]);

  const roomSeenAt = useCallback(() => roomSeenRef.current, []);

  return { dm, room, dmPlusRoom: dm + room, markRoomSeen, roomSeenAt, refresh };
}
