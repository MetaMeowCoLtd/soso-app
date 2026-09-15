import { Platform } from "react-native";

/**
 * Design tokens, extracted from apps/web/app/globals.css's `:root` block —
 * the one place the web app's actual colour tokens live. There is no `.ts`
 * equivalent on the web side to port from; this file IS the mobile port of
 * that single CSS line, written out where JS can reach it.
 *
 * Kept as a flat colour map rather than semantic names (`background`,
 * `foreground`, ...) because that's how the web app itself uses them —
 * `--teal`/`--hot` are reached for by literal identity throughout
 * globals.css depending on context (a button background here, a border
 * there), not through one semantic mapping. Renaming them into semantic
 * roles here would invent a structure the source of truth doesn't have.
 */
export const COLORS = {
  ink: "#17241f",
  deep: "#12302b",
  teal: "#00a78f",
  mint: "#d9fff5",
  hot: "#ff5b7c",
  muted: "#6b807a",
  /** RN's style system accepts standard rgba() strings directly — no conversion needed. */
  line: "rgba(20,50,43,0.13)",
  glass: "rgba(255,255,255,0.87)",
  hairline: "rgba(20,50,43,0.09)",
  /** Screen/body background outside the map, from globals.css's `html`/`body` rule. */
  screenBackground: "#bcd9d2",
} as const;

/**
 * Elevation shadows, from globals.css's `--e1`/`--e2`/`--e3`.
 *
 * Each web token is a stacked TWO-layer `box-shadow` (a tight, low-opacity
 * layer plus a soft, wider one) — RN's shadow model (`shadowColor`/
 * `shadowOffset`/`shadowOpacity`/`shadowRadius` on iOS, `elevation` on
 * Android) has no equivalent for stacking two shadows on one view, so each
 * of these is a single-layer approximation: offset and radius roughly
 * split between the two CSS layers, opacity averaged rather than summed.
 * Close enough to read as "the same three elevation steps," not a pixel
 * match — a genuine two-layer effect would need two overlapping views.
 */
const SHADOW_COLOR = "rgb(16,44,37)";

function iosShadow(offsetY: number, radius: number, opacity: number) {
  return {
    shadowColor: SHADOW_COLOR,
    shadowOffset: { width: 0, height: offsetY },
    shadowRadius: radius,
    shadowOpacity: opacity,
  };
}

// Not `Platform.select`: its overloads infer one shape shared across every
// platform branch, and iOS's shadow* props and Android's `elevation` don't
// share a shape. A plain OS check keeps each branch's own object literal.
function elevation(iosArgs: [offsetY: number, radius: number, opacity: number], androidElevation: number) {
  return Platform.OS === "android" ? { elevation: androidElevation } : iosShadow(...iosArgs);
}

export const SHADOWS = {
  e1: elevation([1, 4, 0.06], 1),
  e2: elevation([4, 12, 0.08], 4),
  e3: elevation([10, 24, 0.12], 8),
} as const;
