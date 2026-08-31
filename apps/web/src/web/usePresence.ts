"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { areaCellOf, type Friend, type FriendTier, type MyProfile, type SosoGateway } from "soso-core";

/**
 * Presence and the social graph.
 *
 * The heartbeat interval is deliberately shorter than the server's 5-minute
 * online window (see `soso.presence_window()`), so a brief network hiccup does
 * not make someone flicker offline to their friends. It is not much shorter:
 * presence is not real-time chat, and every heartbeat is a write.
 *
 * Nothing here runs unless the user has explicitly turned sharing on. The
 * "off" state performs no writes at all, so a user who never enables it leaves
 * no trace on the server, which is the point of the whole design.
 */

const HEARTBEAT_MS = 90_000;
const FRIENDS_REFRESH_MS = 60_000;

/**
 * Persisted so the toggle survives a reload. Only a local preference: the
 * server's source of truth is whether a `presence` row exists, and stopping
 * the heartbeat is by itself enough to go stale.
 */
const SHARING_KEY = "soso:presence-sharing:v1";

function readStoredSharing(): boolean {
  try {
    return window.localStorage.getItem(SHARING_KEY) === "true";
  } catch {
    return false;
  }
}

function writeStoredSharing(enabled: boolean): void {
  try {
    window.localStorage.setItem(SHARING_KEY, String(enabled));
  } catch {
    // Private browsing or full storage: the toggle simply will not persist
    // across reloads, which is a acceptable degradation for a preference.
  }
}

export interface UsePresenceResult {
  sharing: boolean;
  setSharing: (enabled: boolean) => void;
  /** People active in the current coarse area. Includes you when sharing. */
  areaCount: number | null;
  friends: Friend[];
  me: MyProfile | null;
  busy: boolean;
  error: string | null;
  refreshFriends: () => void;
  follow: (handle: string) => Promise<void>;
  unfollow: (userId: string) => Promise<void>;
  block: (userId: string) => Promise<void>;
  /** Marks a friend close/standard. Private and one-directional — see setFriendTier on the gateway. */
  setFriendTier: (userId: string, tier: FriendTier) => Promise<void>;
}

export function usePresence(
  gateway: SosoGateway,
  enabled: boolean,
  centre: { lng: number; lat: number } | null,
): UsePresenceResult {
  const [sharing, setSharingState] = useState(false);
  const [areaCount, setAreaCount] = useState<number | null>(null);
  const [friends, setFriends] = useState<Friend[]>([]);
  const [me, setMe] = useState<MyProfile | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Read in an effect rather than a useState initialiser so the server render
  // and the first client render agree; localStorage does not exist on the
  // server and a mismatch here would be a hydration error.
  useEffect(() => setSharingState(readStoredSharing()), []);

  useEffect(() => {
    if (!enabled) return;
    void gateway.myProfile().then(setMe).catch(() => setMe(null));
  }, [gateway, enabled]);

  // Keep the latest centre in a ref so the heartbeat interval does not need to
  // be torn down and recreated every time the map moves.
  const centreRef = useRef(centre);
  centreRef.current = centre;

  const refreshFriends = useCallback(() => {
    if (!enabled) return;
    void gateway
      .friendsPresence()
      .then(setFriends)
      .catch(() => setFriends([]));
  }, [gateway, enabled]);

  const refreshCount = useCallback(() => {
    if (!enabled || !centreRef.current) return;
    const cell = areaCellOf(centreRef.current.lng, centreRef.current.lat);
    void gateway
      .areaPresenceCount(cell)
      .then(setAreaCount)
      .catch(() => setAreaCount(null));
  }, [gateway, enabled]);

  // The heartbeat. Only runs while sharing is on.
  useEffect(() => {
    if (!enabled || !sharing) return;

    const beat = () => {
      const at = centreRef.current;
      if (!at) return;
      void gateway.presenceHeartbeat(at).then(refreshCount).catch(() => {});
    };

    beat();
    const id = setInterval(beat, HEARTBEAT_MS);

    // A backgrounded tab should not keep announcing presence. Stopping the
    // heartbeat is enough; the row goes stale on its own.
    const onVisibility = () => {
      if (document.visibilityState === "visible") beat();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [gateway, enabled, sharing, refreshCount]);

  // The area count is readable whether or not you share your own presence.
  // Seeing that a place is busy does not require broadcasting that you are in
  // it, and requiring that trade would push people into sharing by default.
  useEffect(() => {
    if (!enabled) return;
    refreshCount();
    const id = setInterval(refreshCount, HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [enabled, refreshCount, centre?.lng, centre?.lat]);

  useEffect(() => {
    if (!enabled) return;
    refreshFriends();
    const id = setInterval(refreshFriends, FRIENDS_REFRESH_MS);
    return () => clearInterval(id);
  }, [enabled, refreshFriends]);

  const setSharing = useCallback(
    (next: boolean) => {
      setSharingState(next);
      writeStoredSharing(next);
      setError(null);
      if (!next) {
        void gateway.stopSharingPresence().catch(() => {});
        setAreaCount(null);
      }
    },
    [gateway],
  );

  const follow = useCallback(
    async (handle: string) => {
      setBusy(true);
      setError(null);
      try {
        const result = await gateway.followByHandle(handle);
        refreshFriends();
        if (!result.mutual) {
          // Worth saying plainly: a one-way follow shows nothing at all, so
          // without this the feature looks broken rather than pending.
          setError(`Following @${result.handle}. You'll see each other once they add you back.`);
        }
      } catch (err) {
        setError(
          err instanceof Error && err.message === "soso/user_not_found"
            ? "No user with that handle."
            : err instanceof Error && err.message === "soso/cannot_follow_self"
              ? "That's your own handle."
              : err instanceof Error
                ? err.message
                : "Could not add that person.",
        );
      } finally {
        setBusy(false);
      }
    },
    [gateway, refreshFriends],
  );

  const unfollow = useCallback(
    async (userId: string) => {
      await gateway.unfollowUser(userId);
      refreshFriends();
    },
    [gateway, refreshFriends],
  );

  const block = useCallback(
    async (userId: string) => {
      await gateway.blockUser(userId);
      refreshFriends();
    },
    [gateway, refreshFriends],
  );

  // Optimistic: the friend list is what the tier toggle reads to render its
  // own state, so waiting for the next `refreshFriends` poll (up to 60s away)
  // would make a tap look like it did nothing. Reverts on failure rather than
  // trusting the optimistic value, since the server is the one place that
  // actually knows whether the follow is still mutual.
  const setFriendTier = useCallback(
    async (userId: string, tier: FriendTier) => {
      const previous = friends;
      setFriends((current) => current.map((f) => (f.id === userId ? { ...f, tier } : f)));
      setError(null);
      try {
        await gateway.setFriendTier(userId, tier);
      } catch (err) {
        setFriends(previous);
        setError(
          err instanceof Error && err.message === "soso/not_friends"
            ? "You need to follow each other before marking someone close."
            : "Couldn't update that. Try again.",
        );
      }
    },
    [gateway, friends],
  );

  return {
    sharing,
    setSharing,
    areaCount,
    friends,
    me,
    busy,
    error,
    refreshFriends,
    follow,
    unfollow,
    block,
    setFriendTier,
  };
}
