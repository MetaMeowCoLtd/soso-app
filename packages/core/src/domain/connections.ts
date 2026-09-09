/**
 * Follower / following list logic.
 *
 * Pure and I/O-free like the rest of this folder, which is what lets the two
 * decisions the list screen actually makes — "what does this row say about
 * our relationship" and "does this row match what was typed" — be tested
 * directly rather than only by looking at a rendered list.
 */

/**
 * What the viewer's relationship to one row IS, collapsed from the two
 * independent follow edges into the single thing the UI has to render.
 *
 * A five-state enum rather than a pair of booleans at the call site, because
 * the interesting states are not symmetric and the UI treats them
 * differently: `follows_you` is the one that deserves a prompt (they made a
 * move, you haven't answered), `mutual` is the one that unlocks DMs and
 * presence elsewhere in this app, and `self` must never be offered a follow
 * button at all. Deriving this in one tested place keeps four call sites in
 * the view from each re-deciding it slightly differently.
 */
export type ConnectionRelationship = 'self' | 'mutual' | 'follows_you' | 'following' | 'none';

export function connectionRelationship(person: {
  isSelf: boolean;
  isFollowing: boolean;
  followsYou: boolean;
}): ConnectionRelationship {
  // Checked first and unconditionally: your own row can carry any
  // combination of the other two flags (you cannot follow yourself, but a
  // backend that ever said otherwise must not produce a "Follow" button
  // pointed at the viewer).
  if (person.isSelf) return 'self';
  if (person.isFollowing && person.followsYou) return 'mutual';
  if (person.followsYou) return 'follows_you';
  if (person.isFollowing) return 'following';
  return 'none';
}

/**
 * Filters a loaded list by what someone typed.
 *
 * Matches display name OR handle, case-insensitively, on a substring rather
 * than a prefix — people search for the memorable middle of a name ("naka")
 * far more often than they type someone's handle from its first character.
 *
 * A blank or whitespace-only query returns the input UNCHANGED (the same
 * array reference), not a copy: an empty search box means "no filter", and
 * returning a fresh array for every keystroke that clears the field would
 * churn React's list reconciliation for nothing.
 *
 * NOTE this filters what has been LOADED, not what exists — the list pages
 * in as you scroll, so a search before the last page has arrived can only
 * match what has arrived. The view says so on screen rather than quietly
 * presenting partial results as complete; see ConnectionsView's own note.
 */
export function filterConnections<T extends { handle: string; displayName: string }>(
  people: readonly T[],
  query: string,
): readonly T[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return people;
  return people.filter(
    (p) =>
      p.displayName.toLowerCase().includes(needle) || p.handle.toLowerCase().includes(needle),
  );
}
