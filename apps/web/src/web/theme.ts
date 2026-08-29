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
 */

export interface CategoryLook {
  icon: string;
  color: string;
}

const LOOK: Record<string, CategoryLook> = {
  incident: { icon: "⚠", color: "#dc2626" },
  construction: { icon: "🚧", color: "#b45309" },
  lost: { icon: "?", color: "#2563eb" },
  found: { icon: "✓", color: "#059669" },
  seats: { icon: "🍽", color: "#7c3aed" },
  // Modelled server-side, disabled for now. Present here so enabling one is a
  // seed.sql change, not a client change too.
  poll: { icon: "🗳", color: "#c026d3" },
  news: { icon: "📰", color: "#0f766e" },
};

const FALLBACK: CategoryLook = { icon: "•", color: "#6b7684" };

export function lookOf(categoryKey: string): CategoryLook {
  return LOOK[categoryKey] ?? FALLBACK;
}
