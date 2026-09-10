"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  connectionRelationship,
  filterConnections,
  type Connection,
  type ConnectionRelationship,
  type SosoGateway,
} from "soso-core";
import { Avatar } from "./Avatar";
import { Icon, ICONS } from "./Icon";

/**
 * Who follows someone, and who they follow.
 *
 * WHERE THIS PARTS FROM INSTAGRAM, ON PURPOSE
 * ---------------------------------------------------------------------
 * Instagram's version of this screen is three underline tabs, a search box,
 * a "Categories" block, a sort control, and then a flat list of rows that
 * are avatar + username + full name + a button. Four things are wrong with
 * it for this app:
 *
 *   1. A row never tells you whether that person follows YOU. Someone who
 *      followed you last week and someone you have never interacted with
 *      render identically, both offering a bare "Follow" — so the one
 *      decision this screen exists to support (who is worth following
 *      back) is the one it gives you nothing for. Every row here carries
 *      its real relationship: a "Follows you" chip, a "Mutual" chip, and a
 *      button that says "Follow back" rather than "Follow" when that is
 *      what it would do.
 *
 *   2. Its rows rank people by nothing. This app has a real measure of a
 *      person — pins contributed, the stat the profile itself leads with —
 *      so it is on every row. A count of zero is omitted rather than shown
 *      as "0 pins", the same rule FeedCard's like/reply counts follow.
 *
 *   3. Bio is nowhere, so deciding about a stranger means opening their
 *      profile and coming back. One clamped line costs a row nothing and
 *      answers the question in place.
 *
 *   4. Its "Categories" (least interacted with, people you don't follow
 *      back) are computed from engagement data this app does not collect.
 *      They are deliberately NOT imitated: a section that looked like
 *      Instagram's and was populated by guesswork would be worse than not
 *      having it. "People you don't follow back" is, in effect, already
 *      here — it is every row wearing a "Follows you" chip.
 *
 * The counts stay in the segmented control rather than above it, so
 * switching lists and reading their sizes is one glance, not two.
 *
 * WHY THE TAB BAR STAYS VISIBLE UNDER THIS
 * ---------------------------------------------------------------------
 * Same reasoning as ProfileView's own z-index note in globals.css: browsing
 * people is browsing, not a task you are locked into, so the nav stays
 * reachable. See `switchTab` in page.tsx for the half of that which closes
 * this when another tab is tapped.
 */

type Tab = "followers" | "following";

interface ConnectionsViewProps {
  gateway: SosoGateway;
  /** Whose lists these are — the id `list_followers`/`list_following` are anchored on. */
  userId: string;
  /** For the header, so it is clear whose followers these are. */
  handle: string;
  displayName: string;
  /**
   * Counts as the profile reported them. A snapshot on purpose: they
   * describe the profile owner's totals, which a follow performed from
   * inside this list does not change (you are not who is being counted),
   * and the profile refetches them when it is next opened.
   */
  followers: number;
  following: number;
  /** Which list the tapped stat asked for. */
  initialTab: Tab;
  onClose: () => void;
  onOpenProfile: (handle: string) => void;
}

interface ListState {
  people: Connection[];
  cursor: string | null;
  /** Distinguishes "not asked yet" from "asked and it was empty". */
  loaded: boolean;
  loading: boolean;
  loadingMore: boolean;
  atEnd: boolean;
  failed: boolean;
}

const EMPTY: ListState = {
  people: [],
  cursor: null,
  loaded: false,
  loading: false,
  loadingMore: false,
  atEnd: false,
  failed: false,
};

/** The chip a row wears, or null for the states that deserve no chip. */
const CHIP: Partial<Record<ConnectionRelationship, { label: string; className: string }>> = {
  mutual: { label: "Mutual", className: "mutual" },
  follows_you: { label: "Follows you", className: "follows-you" },
  self: { label: "You", className: "self" },
};

export default function ConnectionsView({
  gateway,
  userId,
  handle,
  displayName,
  followers,
  following,
  initialTab,
  onClose,
  onOpenProfile,
}: ConnectionsViewProps) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [query, setQuery] = useState("");
  // Both lists live here rather than one being refetched on every switch.
  // Two reasons: flicking between them stops costing a round trip each way,
  // and an optimistic follow survives the switch instead of appearing to
  // undo itself when the other tab's fetch returns the pre-follow state.
  const [lists, setLists] = useState<Record<Tab, ListState>>({
    followers: EMPTY,
    following: EMPTY,
  });
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());

  const patchList = useCallback((which: Tab, patch: Partial<ListState>) => {
    setLists((prev) => ({ ...prev, [which]: { ...prev[which], ...patch } }));
  }, []);

  const fetchPage = useCallback(
    async (which: Tab, before?: string) => {
      const load = which === "followers" ? gateway.listFollowers : gateway.listFollowing;
      // .call so the gateway keeps its own `this` — the demo gateway is an
      // object literal of methods, not a class instance.
      return load.call(gateway, userId, before);
    },
    [gateway, userId],
  );

  /**
   * Which tabs have had their first fetch STARTED, tracked in a ref rather
   * than read off `lists`.
   *
   * The obvious version of this effect — read `lists[tab].loaded`, and put
   * `lists` in the dependency array — cancels its own request. Its first act
   * is to set `loading: true`, which changes `lists`, which re-runs the
   * effect, which runs the previous run's cleanup, which flips that run's
   * `alive` to false and makes it discard the response it is waiting on. The
   * list would then sit on its skeletons permanently. Demo mode hid this
   * completely: its "fetch" resolves in a microtask, before React gets to
   * the re-render that would have cancelled it, so the bug is invisible
   * precisely where it is easiest to look and certain on a real network.
   */
  const requestedRef = useRef<Set<Tab>>(new Set());
  const [retryNonce, setRetryNonce] = useState(0);

  // A different person means different lists; nothing already fetched
  // applies. (page.tsx also keys this component by profile id, so in
  // practice this is belt and braces rather than the only guard.)
  useEffect(() => {
    requestedRef.current = new Set();
    setLists({ followers: EMPTY, following: EMPTY });
  }, [userId]);

  // Lazily: the tab you did not open is not fetched until you open it.
  useEffect(() => {
    if (requestedRef.current.has(tab)) return;
    requestedRef.current.add(tab);
    let alive = true;
    patchList(tab, { loading: true, failed: false });
    void (async () => {
      try {
        const page = await fetchPage(tab);
        if (!alive) return;
        patchList(tab, {
          people: page.people,
          cursor: page.cursor,
          atEnd: page.cursor === null,
          loaded: true,
          loading: false,
        });
      } catch {
        if (alive) patchList(tab, { loading: false, loaded: true, failed: true });
      }
    })();
    return () => {
      alive = false;
    };
  }, [tab, retryNonce, fetchPage, patchList]);

  function retry() {
    requestedRef.current.delete(tab);
    patchList(tab, { loaded: false, failed: false });
    // The effect above is deliberately not keyed on `lists`, so clearing the
    // ref alone would not restart it — this is what does.
    setRetryNonce((n) => n + 1);
  }

  /**
   * `loadMore` reads current state through a ref and is therefore STABLE.
   *
   * A version that closed over `lists` would get a new identity on every
   * page, every optimistic follow, every retry — and since the observer is
   * attached in terms of it, the IntersectionObserver would be torn down and
   * rebuilt on each one, re-firing against a sentinel that has not moved.
   * The ref keeps one observer alive for the life of the sentinel.
   */
  const stateRef = useRef({ lists, tab });
  useEffect(() => {
    stateRef.current = { lists, tab };
  }, [lists, tab]);

  const loadMore = useCallback(() => {
    const { lists: current, tab: which } = stateRef.current;
    const state = current[which];
    if (!state.loaded || state.loadingMore || state.atEnd || !state.cursor) return;
    const cursor = state.cursor;
    patchList(which, { loadingMore: true });
    void (async () => {
      try {
        const page = await fetchPage(which, cursor);
        setLists((prev) => {
          const existing = prev[which];
          // Guard against a duplicate row if two loads ever overlap — the
          // list is keyed by id, and React would warn loudly rather than
          // just look slightly wrong.
          const seen = new Set(existing.people.map((p) => p.id));
          const added = page.people.filter((p) => !seen.has(p.id));
          return {
            ...prev,
            [which]: {
              ...existing,
              people: [...existing.people, ...added],
              cursor: page.cursor,
              atEnd: page.cursor === null,
              loadingMore: false,
            },
          };
        });
      } catch {
        // Stops paging rather than retrying forever against a failing call;
        // the rows already loaded stay usable.
        patchList(which, { loadingMore: false, atEnd: true });
      }
    })();
  }, [fetchPage, patchList]);

  /**
   * A callback ref, not `useRef` + an effect: the sentinel is conditionally
   * rendered (it disappears while searching, and before the first page
   * lands), and a callback ref is told about every mount and unmount of it,
   * where an effect would have to guess at the right dependencies to
   * re-check `.current` at the right moment.
   */
  const observerRef = useRef<IntersectionObserver | null>(null);
  const sentinelRef = useCallback(
    (node: HTMLDivElement | null) => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      if (!node) return;
      const observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) loadMore();
        },
        // A margin ahead of the viewport edge so the next page is already
        // arriving before someone reaches the bottom, matching FeedTab.
        { rootMargin: "400px" },
      );
      observer.observe(node);
      observerRef.current = observer;
    },
    [loadMore],
  );

  useEffect(() => () => observerRef.current?.disconnect(), []);

  /**
   * Applies a change to one person in BOTH lists, not just the visible one.
   * A mutual follow legitimately appears in each, and following someone from
   * the followers tab must not leave a stale "Follow" button on the same
   * person sitting in the following tab.
   */
  function updatePerson(id: string, patch: Partial<Connection>) {
    setLists((prev) => {
      const apply = (state: ListState): ListState => ({
        ...state,
        people: state.people.map((p) => (p.id === id ? { ...p, ...patch } : p)),
      });
      return { followers: apply(prev.followers), following: apply(prev.following) };
    });
  }

  async function toggleFollow(person: Connection) {
    if (busyIds.has(person.id) || person.isSelf) return;
    setBusyIds((prev) => new Set(prev).add(person.id));
    const wasFollowing = person.isFollowing;
    // Optimistic, same as ProfileView's own follow button: the row flips
    // immediately and reconciles on the response.
    updatePerson(person.id, { isFollowing: !wasFollowing });
    try {
      if (wasFollowing) {
        await gateway.unfollowUser(person.id);
      } else {
        await gateway.followByHandle(person.handle);
      }
    } catch {
      updatePerson(person.id, { isFollowing: wasFollowing });
    } finally {
      setBusyIds((prev) => {
        const next = new Set(prev);
        next.delete(person.id);
        return next;
      });
    }
  }

  const state = lists[tab];
  const visible = filterConnections(state.people, query);
  const searching = query.trim().length > 0;

  return (
    <div className="connections-view" role="dialog" aria-modal="true" aria-label={`${displayName}'s connections`}>
      <header className="connections-head">
        <button type="button" className="connections-back" onClick={onClose} aria-label="Back">
          <Icon src={ICONS.chevronLeft} size={20} />
        </button>
        <span className="connections-title">
          <strong>{displayName}</strong>
          <span>@{handle}</span>
        </span>
      </header>

      {/* A segmented pill rather than Instagram's underline tabs: the count
          belongs with the label it counts, and a filled pill makes which
          list you are in readable at a glance on a busy screen. */}
      <div className="connections-tabs" role="tablist" aria-label="Followers and following">
        {(["followers", "following"] as const).map((which) => (
          <button
            key={which}
            type="button"
            role="tab"
            aria-selected={tab === which}
            className={`connections-tab${tab === which ? " active" : ""}`}
            onClick={() => {
              setTab(which);
              // A query typed against one list means nothing in the other.
              setQuery("");
            }}
          >
            <strong>{which === "followers" ? followers : following}</strong>
            <span>{which === "followers" ? "Followers" : "Following"}</span>
          </button>
        ))}
      </div>

      <label className="connections-search">
        <Icon src={ICONS.search} size={16} />
        <input
          type="search"
          inputMode="search"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder={tab === "followers" ? "Search followers" : "Search following"}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label={tab === "followers" ? "Search followers" : "Search following"}
        />
        {query.length > 0 && (
          <button
            type="button"
            className="connections-search-clear"
            onClick={() => setQuery("")}
            aria-label="Clear search"
          >
            <Icon src={ICONS.close} size={12} />
          </button>
        )}
      </label>

      <div className="connections-scroll">
        {state.loading ? (
          <ul className="connections-list" aria-busy="true" aria-label="Loading people">
            <ConnectionSkeleton />
            <ConnectionSkeleton />
            <ConnectionSkeleton />
            <ConnectionSkeleton />
          </ul>
        ) : state.failed ? (
          <p className="connections-status">
            Couldn&rsquo;t load this list.{" "}
            <button type="button" className="connections-retry" onClick={retry}>
              Try again
            </button>
          </p>
        ) : visible.length === 0 ? (
          <p className="connections-status">
            {searching
              ? `No one here matching “${query.trim()}”.`
              : tab === "followers"
                ? "No followers yet."
                : "Not following anyone yet."}
          </p>
        ) : (
          <ul className="connections-list">
            {visible.map((person) => (
              <ConnectionRow
                key={person.id}
                person={person}
                avatarSrc={gateway.avatarUrl(person.avatarPath)}
                busy={busyIds.has(person.id)}
                onOpenProfile={onOpenProfile}
                onToggleFollow={() => void toggleFollow(person)}
              />
            ))}
          </ul>
        )}

        {/* Said plainly rather than left for someone to discover: the filter
            runs over what has been paged in, so until the last page has
            arrived a search genuinely cannot see everyone. */}
        {searching && !state.atEnd && state.loaded && !state.failed && (
          <p className="connections-note">
            Searching the {state.people.length} loaded so far — keep scrolling to load more.
          </p>
        )}

        {state.loaded && !state.atEnd && !searching && (
          <div ref={sentinelRef} className="connections-sentinel">
            {state.loadingMore && <span className="connections-status">Loading more…</span>}
          </div>
        )}
      </div>
    </div>
  );
}

function ConnectionSkeleton() {
  return (
    <li className="connection-row connection-row-skeleton" aria-hidden="true">
      <span className="skeleton-block connection-skeleton-avatar" />
      <span className="connection-id">
        <span className="skeleton-block connection-skeleton-line connection-skeleton-name" />
        <span className="skeleton-block connection-skeleton-line connection-skeleton-handle" />
      </span>
      <span className="skeleton-block connection-skeleton-action" />
    </li>
  );
}

function ConnectionRow({
  person,
  avatarSrc,
  busy,
  onOpenProfile,
  onToggleFollow,
}: {
  person: Connection;
  /** Resolved by the caller — see `SosoGateway.avatarUrl` on why a path is not a URL. */
  avatarSrc: string | null;
  busy: boolean;
  onOpenProfile: (handle: string) => void;
  onToggleFollow: () => void;
}) {
  const relationship = connectionRelationship(person);
  const chip = CHIP[relationship];

  return (
    <li className="connection-row">
      {/* The whole identity block opens the profile; the action button is a
          sibling rather than nested inside it, so there is no interactive
          element inside an interactive element to make click targets and
          screen-reader output ambiguous. */}
      <button
        type="button"
        className="connection-who"
        onClick={() => onOpenProfile(person.handle)}
        aria-label={`View ${person.displayName}'s profile`}
      >
        <Avatar name={person.displayName} seed={person.handle} src={avatarSrc} size={46} />
        <span className="connection-id">
          <span className="connection-name">
            <strong>{person.displayName}</strong>
            {chip && <span className={`connection-chip ${chip.className}`}>{chip.label}</span>}
          </span>
          <span className="connection-handle">
            @{person.handle}
            {/* Omitted at zero, like every other count in this app — "0 pins"
                on every row of a young account makes the list look dead. */}
            {person.pins > 0 && (
              <>
                {" · "}
                <span className="connection-pins">📍 {person.pins}</span>
              </>
            )}
          </span>
          {person.bio && <span className="connection-bio">{person.bio}</span>}
        </span>
      </button>

      {relationship !== "self" && (
        <button
          type="button"
          className={`connection-follow${person.isFollowing ? " following" : ""}`}
          onClick={onToggleFollow}
          disabled={busy}
        >
          {person.isFollowing ? "Following" : relationship === "follows_you" ? "Follow back" : "Follow"}
        </button>
      )}
    </li>
  );
}
