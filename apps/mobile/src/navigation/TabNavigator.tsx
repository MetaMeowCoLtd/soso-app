import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";

import { useUnreadCountsContext } from "../chat/UnreadCountsProvider";
import ChatTabScreen from "../screens/ChatTabScreen";
import FeedTabScreen from "../screens/FeedTabScreen";
import MapTabScreen from "../screens/MapTabScreen";
import PeopleTabScreen from "../screens/PeopleTabScreen";
import ProfileTabScreen from "../screens/ProfileTabScreen";
import { Icon, ICONS } from "../theme/Icon";
import { COLORS } from "../theme/tokens";
import type { TabParamList } from "./types";
import { ProfileTabIcon } from "./ProfileTabIcon";

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
 * Icons: Map/Feed/Chat/People use the ported SVG set (theme/Icon.tsx, C3).
 * Profile uses the signed-in person's own avatar instead — see
 * ProfileTabIcon.tsx for why there's no plain "person" glyph to reach for.
 * Left as plain text through C5-C8 with a comment promising this "is C8/C9
 * work" — overdue the moment C8 actually built the icon system; React
 * Navigation's default fallback for a tab with no `tabBarIcon` is a small
 * placeholder triangle, which is what was on screen until now.
 */
export function TabNavigator() {
  // `dmPlusRoom` from the one shared UnreadCountsProvider instance — see
  // that file's own note on why the badge needs a shared instance rather
  // than a screen-local `useUnreadCounts()` that would stop counting the
  // moment the Chat tab loses focus, which is exactly when a badge matters.
  const { dmPlusRoom } = useUnreadCountsContext();

  return (
    <Tab.Navigator screenOptions={{ headerShown: false, tabBarActiveTintColor: COLORS.teal, tabBarInactiveTintColor: COLORS.muted }}>
      <Tab.Screen
        name="MapTab"
        component={MapTabScreen}
        options={{ title: "Map", tabBarIcon: ({ color, size }) => <Icon src={ICONS.map} size={size} color={color} /> }}
      />
      <Tab.Screen
        name="FeedTab"
        component={FeedTabScreen}
        options={{ title: "Feed", tabBarIcon: ({ color, size }) => <Icon src={ICONS.feed} size={size} color={color} /> }}
      />
      <Tab.Screen
        name="ChatTab"
        component={ChatTabScreen}
        options={{
          title: "Chat",
          tabBarIcon: ({ color, size }) => <Icon src={ICONS.chat} size={size} color={color} />,
          tabBarBadge: dmPlusRoom > 0 ? dmPlusRoom : undefined,
        }}
      />
      <Tab.Screen
        name="PeopleTab"
        component={PeopleTabScreen}
        options={{ title: "People", tabBarIcon: ({ color, size }) => <Icon src={ICONS.people} size={size} color={color} /> }}
      />
      <Tab.Screen
        name="ProfileTab"
        component={ProfileTabScreen}
        options={{ title: "Profile", tabBarIcon: ({ size }) => <ProfileTabIcon size={size} /> }}
      />
    </Tab.Navigator>
  );
}
