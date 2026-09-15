import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";

import ChatTabScreen from "../screens/ChatTabScreen";
import FeedTabScreen from "../screens/FeedTabScreen";
import MapTabScreen from "../screens/MapTabScreen";
import PeopleTabScreen from "../screens/PeopleTabScreen";
import ProfileTabScreen from "../screens/ProfileTabScreen";
import { COLORS } from "../theme/tokens";
import type { TabParamList } from "./types";

const Tab = createBottomTabNavigator<TabParamList>();

/**
 * The five bottom tabs from apps/web's `activeTab` (app/page.tsx:204).
 *
 * The plan called for `MapTab` to keep `unmountOnBlur: false`, matching
 * the web version's own choice to CSS-hide the map tab rather than unmount
 * it (app/page.tsx:197-203) so its pin composer and location-watch
 * subscription never restart on a tab switch. That option doesn't exist on
 * this version of @react-navigation/bottom-tabs (v7) — it was removed
 * along with the whole unmount-on-blur model. React Navigation v7's
 * screens (built on react-native-screens) already stay mounted once
 * visited by default, with nothing that unmounts a blurred tab, so the
 * original requirement is satisfied by v7's default behaviour with no
 * extra configuration at all. `freezeOnBlur` is the v7 equivalent of a
 * once-visited screen's lifecycle knob — it only *pauses re-rendering*,
 * never unmounts — and defaults to `false` everywhere unless `enableFreeze()`
 * is called globally, which nothing here does yet. If a later checkpoint
 * adopts `enableFreeze()` for the other four tabs' performance, MapTab
 * should get `freezeOnBlur: false` explicitly at that point to keep this
 * guarantee; there's nothing to set today.
 *
 * Icons/labels are deliberately plain text for now — the tab bar's actual
 * look (icons from theme/Icon.tsx, badge counts from useUnreadCounts) is
 * C8/C9 work once those screens exist; this is the routing shell.
 */
export function TabNavigator() {
  return (
    <Tab.Navigator screenOptions={{ headerShown: false, tabBarActiveTintColor: COLORS.teal }}>
      <Tab.Screen name="MapTab" component={MapTabScreen} options={{ title: "Map" }} />
      <Tab.Screen name="FeedTab" component={FeedTabScreen} options={{ title: "Feed" }} />
      <Tab.Screen name="ChatTab" component={ChatTabScreen} options={{ title: "Chat" }} />
      <Tab.Screen name="PeopleTab" component={PeopleTabScreen} options={{ title: "People" }} />
      <Tab.Screen name="ProfileTab" component={ProfileTabScreen} options={{ title: "Profile" }} />
    </Tab.Navigator>
  );
}
