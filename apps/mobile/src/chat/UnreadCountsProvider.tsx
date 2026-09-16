import { createContext, useContext, type ReactNode } from "react";

import { useGateway } from "../gate/AppGate";
import { useUnreadCounts, type UnreadCounts } from "./useUnreadCounts";

/**
 * The Chat tab's badge (`TabNavigator`) and the room view itself
 * (`ChatTabScreen`) both need the same unread counter — the badge has to
 * keep counting while the tab sits unfocused, which is exactly the same
 * "one shared instance, not two independent ones that desync" problem
 * `PresenceProvider` solved for the People tab and Settings in C8. Same
 * fix here: one `useUnreadCounts` instance, wrapped around the navigator
 * in App.tsx, read from both places through this context.
 */
const UnreadCountsContext = createContext<UnreadCounts | null>(null);

export function UnreadCountsProvider({ children }: { children: ReactNode }) {
  const gateway = useGateway();
  const counts = useUnreadCounts(gateway);
  return <UnreadCountsContext.Provider value={counts}>{children}</UnreadCountsContext.Provider>;
}

export function useUnreadCountsContext(): UnreadCounts {
  const value = useContext(UnreadCountsContext);
  if (!value) throw new Error("useUnreadCountsContext used outside UnreadCountsProvider");
  return value;
}
