import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";

import { areaCellOf, type Friend, type FriendTier, type MyProfile, type SosoGateway } from "../core";

/**
 * Ported from apps/web/src/web/usePresence.ts. The heartbeat interval, the
 * social-graph calls, the optimistic `setFriendTier` — all unchanged, none
 * of it is a browser API. Two mechanical swaps: `localStorage` for the
 * `sharing` toggle becomes `AsyncStorage` (so reading it is now an effect
 * rather than available synchronously — there's no hydration-mismatch
 * concern to avoid here the way there was on web, since RN has no
 * server-render pass to agree with), and `document.visibilitychange`
 * becomes `AppState`.
 */

const HEARTBEAT_MS = 90_000;
const FRIENDS_REFRESH_MS = 60_000;

/** Persisted so the toggle survives a relaunch — see the web version's identical note on why this is a local preference, not a security boundary. */
const SHARING_KEY = "soso:presence-sharing:v1";

async function readStoredSharing(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(SHARING_KEY)) === "true";
  } catch {
    return false;
  }
}

async function writeStoredSharing(enabled: boolean): Promise<void> {
  try {
    await AsyncStorage.setItem(SHARING_KEY, String(enabled));
  } catch {
    // Storage full or unavailable: the toggle simply won't persist across
    // relaunches, an acceptable degradation for a preference.
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
  /** Re-fetch your own profile — after editing your name or bio, so `me` isn't stale. */
  refreshMe: () => void;
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

  useEffect(() => {
    readStoredSharing().then(setSharingState);
  }, []);

  const refreshMe = useCallback(() => {
    if (!enabled) return;
    void gateway.myProfile().then(setMe).catch(() => {});
  }, [gateway, enabled]);

  useEffect(() => {
    if (!enabled) {
      setMe(null);
      return;
    }
    refreshMe();
  }, [enabled, refreshMe]);

  // Keep the latest centre in a ref so the heartbeat interval does not need
  // to be torn down and recreated every time the map moves.
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

    // A backgrounded app should not keep announcing presence. Stopping the
    // heartbeat is enough; the row goes stale on its own.
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") beat();
    });

    return () => {
      clearInterval(id);
      subscription.remove();
    };
  }, [gateway, enabled, sharing, refreshCount]);

  // The area count is readable whether or not you share your own presence —
  // seeing that a place is busy does not require broadcasting that you are
  // in it.
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

  useEffect(() => {
    if (!enabled) return;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const onFollowsChanged = () => {
      if (debounce) return;
      debounce = setTimeout(() => {
        debounce = null;
        refreshFriends();
      }, 400);
    };
    const unsubscribe = gateway.subscribeFollowsChanged(onFollowsChanged);
    return () => {
      if (debounce) clearTimeout(debounce);
      unsubscribe();
    };
  }, [gateway, enabled, refreshFriends]);

  const setSharing = useCallback(
    (next: boolean) => {
      setSharingState(next);
      void writeStoredSharing(next);
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
    refreshMe,
    follow,
    unfollow,
    block,
    setFriendTier,
  };
}
