import type { FC } from "react";
import type { SvgProps } from "react-native-svg";

import Board from "../../assets/icons/category/board.svg";
import Construction from "../../assets/icons/category/construction.svg";
import Fallback from "../../assets/icons/category/fallback.svg";
import Found from "../../assets/icons/category/found.svg";
import Incident from "../../assets/icons/category/incident.svg";
import Lost from "../../assets/icons/category/lost.svg";
import News from "../../assets/icons/category/news.svg";
import Poll from "../../assets/icons/category/poll.svg";
import Seats from "../../assets/icons/category/seats.svg";
import Suspicious from "../../assets/icons/category/suspicious.svg";
import Update from "../../assets/icons/category/update.svg";

/**
 * Ported from apps/web/src/web/theme.ts. Colours are unchanged — deliberately
 * pastel, matched to the base map's own palette (apps/mobile/src/map/mapStyle.ts):
 * coral roads, mint parks, powder-blue water, lavender rail — rather than
 * picked independently. `icon` changes from a path string to a component
 * reference, for the same Metro-static-import reason as theme/Icon.tsx.
 *
 * A category the server enables that isn't in this map still renders, with
 * the fallback below, rather than crashing.
 */
export interface CategoryLook {
  icon: FC<SvgProps>;
  color: string;
}

const LOOK: Record<string, CategoryLook> = {
  incident: { icon: Incident, color: "#ef7b6c" },
  construction: { icon: Construction, color: "#eba854" },
  lost: { icon: Lost, color: "#6fa4dd" },
  found: { icon: Found, color: "#57bd9a" },
  seats: { icon: Seats, color: "#a98fe0" },
  // The location-optional feed's own category. It never renders as a map
  // pin — an update has no cell.
  update: { icon: Update, color: "#8fa9e0" },
  // Modelled server-side, disabled for now.
  poll: { icon: Poll, color: "#d68fd0" },
  news: { icon: News, color: "#4fa89a" },
  board: { icon: Board, color: "#e07a9a" },
  // A muted, low-alarm colour on purpose: this category is already the one
  // most prone to reading as an accusation, and a loud warning-red marker
  // would add to that rather than just informing.
  suspicious: { icon: Suspicious, color: "#9a8fc2" },
};

const FALLBACK: CategoryLook = { icon: Fallback, color: "#a39a91" };

export function lookOf(categoryKey: string): CategoryLook {
  return LOOK[categoryKey] ?? FALLBACK;
}
