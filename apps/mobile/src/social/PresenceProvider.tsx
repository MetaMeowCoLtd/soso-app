import { useCurrentPosition } from "@maplibre/maplibre-react-native";
import { createContext, useContext, type ReactNode } from "react";

import { useAppGate, useGateway } from "../gate/AppGate";
import { usePresence, type UsePresenceResult } from "./usePresence";

/**
 * A single shared `usePresence` instance, exposed via context.
 *
 * Found the hard way while wiring ProfileSettingsScreen: if that screen and
 * PeopleTabScreen each called `usePresence()` independently, toggling
 * "share presence" in Settings would persist to AsyncStorage correctly but
 * never update the People tab's own copy of `sharing` — React Navigation
 * v7 keeps both tabs' screens mounted (see TabNavigator.tsx's C5 note), so
 * the People tab's hook instance would just keep the stale value it read on
 * its own mount, with nothing telling it to re-read. One instance, shared,
 * makes that class of bug structurally impossible rather than something to
 * remember to avoid.
 */
const PresenceContext = createContext<UsePresenceResult | null>(null);

export function usePresenceContext(): UsePresenceResult {
  const value = useContext(PresenceContext);
  if (!value) throw new Error("usePresenceContext() called outside <PresenceProvider>");
  return value;
}

export function PresenceProvider({ children }: { children: ReactNode }) {
  const gateway = useGateway();
  const { mode } = useAppGate();
  const demoMode = mode === "demo";
  // See PeopleTabScreen's own note on why the device's actual position,
  // not a scrolled map centre, is what feeds the area-count query here.
  const position = useCurrentPosition();
  const centre = position ? { lng: position.coords.longitude, lat: position.coords.latitude } : null;
  const presence = usePresence(gateway, !demoMode, centre);

  return <PresenceContext.Provider value={presence}>{children}</PresenceContext.Provider>;
}
