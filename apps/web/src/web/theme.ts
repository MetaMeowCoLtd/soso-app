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
  icon: string;
  color: string;
}

const LOOK: Record<string, CategoryLook> = {
  incident: { icon: "⚠", color: "#ef7b6c" },
  construction: { icon: "🚧", color: "#eba854" },
  lost: { icon: "?", color: "#6fa4dd" },
  found: { icon: "✓", color: "#57bd9a" },
  seats: { icon: "🍽", color: "#a98fe0" },
  // Modelled server-side, disabled for now. Present here so enabling one is a
  // seed.sql change, not a client change too.
  poll: { icon: "🗳", color: "#d68fd0" },
  news: { icon: "📰", color: "#4fa89a" },
};

const FALLBACK: CategoryLook = { icon: "•", color: "#a39a91" };

export function lookOf(categoryKey: string): CategoryLook {
  return LOOK[categoryKey] ?? FALLBACK;
}
