/**
 * RN equivalent of CSS `filter: saturate(amount)`, applied to one solid hex
 * colour rather than a rendered element — RN views have no filter property
 * at all, so `pinIcon`'s `--pin-saturate` custom property (read by
 * `.soso-pin`'s `filter:saturate()` in globals.css) has to become an actual
 * recoloured value here instead of a CSS variable.
 *
 * Implements the exact matrix the CSS Filter Effects spec defines for
 * `saturate()` — a linear interpolation between the identity matrix and a
 * luminance/grayscale matrix, extrapolated for `amount > 1` — rather than a
 * simplified approximation, so `pinSaturation`'s full [0, MAX_SATURATION]
 * range (packages/core/src/domain/validity.ts) produces the same colour a
 * browser would render.
 */
function clamp255(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

export function saturateHex(hex: string, amount: number): string {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) return hex;
  const r = parseInt(match[1]!, 16);
  const g = parseInt(match[2]!, 16);
  const b = parseInt(match[3]!, 16);

  const s = amount;
  const nr = r * (0.213 + 0.787 * s) + g * (0.715 - 0.715 * s) + b * (0.072 - 0.072 * s);
  const ng = r * (0.213 - 0.213 * s) + g * (0.715 + 0.285 * s) + b * (0.072 - 0.072 * s);
  const nb = r * (0.213 - 0.213 * s) + g * (0.715 - 0.715 * s) + b * (0.072 + 0.928 * s);

  const toHex = (n: number) => clamp255(n).toString(16).padStart(2, "0");
  return `#${toHex(nr)}${toHex(ng)}${toHex(nb)}`;
}
