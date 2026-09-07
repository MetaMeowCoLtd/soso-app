/**
 * Category presentation.
 *
 * `CategoryConfig` from the server carries labels and behaviour, not colour or
 * icon — those are a client concern and stay a client concern, the same way
 * the mobile app's `theme.ts` owns colour independently of the config table.
 *
 * A category the server enables that isn't in this map still renders, with the
 * fallback below, rather than crashing. That matters in practice: flipping
 * `is_enabled` on `news` or `poll` in the database should not require a client
 * deploy to avoid an undefined-icon bug.
 *
 * Colours are deliberately pastel, matched to the same palette family as the
 * base map itself (`mapStyle.ts`) — coral roads, mint parks, powder-blue
 * water, lavender rail — rather than picked independently. Saturated warning
 * colours (a pure `#dc2626` red, for instance) read as officialdom against a
 * soft cream map; a pin should look like part of the same app as the map it
 * sits on.
 */

export interface CategoryLook {
  /**
   * Path to the icon's SVG file, relative to the app root — pass it to
   * `<Icon src={…}>`, which masks it with `currentColor`. These were emoji
   * (⚠ 🚧 🍽 …) until it became clear that a category's icon was a
   * different picture on every platform the map was opened on; see
   * Icon.tsx for the full reasoning.
   */
  icon: string;
  color: string;
}

const LOOK: Record<string, CategoryLook> = {
  incident: { icon: "icons/category/incident.svg", color: "#ef7b6c" },
  construction: { icon: "icons/category/construction.svg", color: "#eba854" },
  lost: { icon: "icons/category/lost.svg", color: "#6fa4dd" },
  found: { icon: "icons/category/found.svg", color: "#57bd9a" },
  seats: { icon: "icons/category/seats.svg", color: "#a98fe0" },
  // The location-optional feed's own category (see FeedTab). It never
  // renders as a map pin — an update has no cell — but it does appear in
  // the composer's category launcher, where it was falling through to the
  // anonymous grey dot below.
  update: { icon: "icons/category/update.svg", color: "#8fa9e0" },
  // Modelled server-side, disabled for now. Present here so enabling one is a
  // seed.sql change, not a client change too.
  poll: { icon: "icons/category/poll.svg", color: "#d68fd0" },
  news: { icon: "icons/category/news.svg", color: "#4fa89a" },
  board: { icon: "icons/category/board.svg", color: "#e07a9a" },
  // Added alongside 20260904000024_enable_suspicious_category.sql. Unlike
  // `harassment` (still no entry, still meant for aggregate-only display
  // whenever that's built), `suspicious` is now enabled and rendering as a
  // normal individual pin -- see that migration's comment for why that's
  // the current reality even though it wasn't the original plan. A muted,
  // low-alarm color on purpose: this category is already the one most prone
  // to reading as an accusation, and a loud warning-red marker would add to
  // that rather than just informing.
  suspicious: { icon: "icons/category/suspicious.svg", color: "#9a8fc2" },
};

const FALLBACK: CategoryLook = { icon: "icons/category/fallback.svg", color: "#a39a91" };

export function lookOf(categoryKey: string): CategoryLook {
  return LOOK[categoryKey] ?? FALLBACK;
}
