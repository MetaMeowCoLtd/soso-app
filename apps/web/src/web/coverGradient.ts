/**
 * A cover gradient derived from a handle, so a person's banner is reliably
 * their own colour — the same hash-to-hue trick `Avatar.tsx` uses for its
 * own colour, widened into a two-tone diagonal. The second hue is offset
 * ~50° so the gradient always has real movement rather than two
 * near-identical shades, and both stops are kept vivid (high saturation,
 * mid-high lightness) so the banner reads as lively, not muted. Pure
 * function of the handle — stable across every visit.
 *
 * A SHARED FILE, NOT A LOCAL FUNCTION IN ProfileView.tsx, because migration
 * 0051 gave it a second caller: ProfileSettings shows the same gradient as
 * the "no cover photo yet" preview behind its own upload control, so the
 * one place someone edits their cover and the one place everyone else sees
 * it agree on what "nothing uploaded" looks like.
 */
export function coverGradient(seed: string): { background: string } {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const h1 = Math.abs(hash) % 360;
  const h2 = (h1 + 48) % 360;
  return {
    background: `linear-gradient(135deg, hsl(${h1} 85% 62%), hsl(${h2} 88% 54%))`,
  };
}
