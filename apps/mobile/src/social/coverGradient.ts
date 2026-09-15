/**
 * Ported from apps/web/src/web/coverGradient.ts. Same FNV-1a hash-to-hue
 * trick `Avatar.tsx` already uses (see that file's own `hueOf`), widened
 * into a two-tone diagonal — returns a colour pair for `expo-linear-gradient`
 * rather than a CSS `background` string, the same boundary Avatar.tsx
 * crosses for its own gradient.
 */
export function coverGradientColors(seed: string): [string, string] {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const h1 = Math.abs(hash) % 360;
  const h2 = (h1 + 48) % 360;
  return [`hsl(${h1}, 85%, 62%)`, `hsl(${h2}, 88%, 54%)`];
}
