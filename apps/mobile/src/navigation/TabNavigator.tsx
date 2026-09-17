import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { createNativeBottomTabNavigator, type NativeBottomTabIcon } from "@react-navigation/bottom-tabs/unstable";
import { useEffect, useState } from "react";
import { Platform } from "react-native";
import type { SFSymbol } from "sf-symbols-typescript";

import { useUnreadCountsContext } from "../chat/UnreadCountsProvider";
import { useGateway } from "../gate/AppGate";
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
const NativeTab = createNativeBottomTabNavigator<TabParamList>();

/**
 * The five bottom tabs from apps/web's `activeTab` (app/page.tsx:204).
 *
 * iOS gets `createNativeBottomTabNavigator` (below) instead of this
 * JS-rendered one — the whole reason being that it's a real
 * `UITabBarController`, which is what picks up the OS's own Liquid Glass
 * automatically (a floating, translucent bar with content peeking through,
 * and the system's own sliding highlight behind the selected tab) with zero
 * bespoke animation code. There is no equivalent material on Android
 * (`BottomNavigationView` has nothing like it), so Android keeps this
 * version untouched — switching it too would only cost the existing
 * hand-tinted SVG icon set for no visual gain, since the native navigator's
 * `tabBarIcon` takes an SF Symbol name or a bundled raster image, not an
 * arbitrary component.
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
 */
export function TabNavigator() {
  return Platform.OS === "ios" ? <IOSGlassTabNavigator /> : <JSTabNavigator />;
}

function JSTabNavigator() {
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

/**
 * SF Symbols standing in for the four hand-drawn SVGs the JS tab bar uses
 * (`ICONS.map`/`feed`/`chat`/`people`) — the native tab bar's `tabBarIcon`
 * takes `{ type: 'sfSymbol', name }` or a bundled raster image, never a
 * component, so the runtime-tinted SVG set (theme/Icon.tsx) can't be
 * reused directly here. Names picked for silhouette, not just meaning: an
 * outline map, a stack of feed cards, a speech bubble, two people — same
 * read as the SVGs they replace, matching Apple's own "prefer SF Symbols
 * for tab bar icons" guidance in the process.
 */
function sfSymbol(name: string): NativeBottomTabIcon {
  return { type: "sfSymbol", name: name as SFSymbol };
}

/**
 * iOS's native tab bar — a real `UITabBarController` via
 * `createNativeBottomTabNavigator`, which is what gets the OS's Liquid
 * Glass material (and its animated selection pill) for free. See this
 * file's module comment for why this is iOS-only.
 */
function IOSGlassTabNavigator() {
  const { dmPlusRoom } = useUnreadCountsContext();
  const gateway = useGateway();
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);

  // Mirrors ProfileTabIcon.tsx's own fetch — that component renders a React
  // element, which the native tab bar's `tabBarIcon` has no way to accept,
  // so the same "look up my own avatar" call is repeated here instead of
  // shared, same as ProfileTabIcon's own note on why it doesn't reach for
  // whichever screen happens to be focused.
  useEffect(() => {
    let cancelled = false;
    gateway.myProfile().then((profile) => {
      if (cancelled || !profile) return;
      setAvatarUrl(gateway.avatarUrl(profile.avatarPath));
    });
    return () => {
      cancelled = true;
    };
  }, [gateway]);

  return (
    <NativeTab.Navigator screenOptions={{ headerShown: false, tabBarActiveTintColor: COLORS.teal }}>
      <NativeTab.Screen name="MapTab" component={MapTabScreen} options={{ title: "Map", tabBarIcon: sfSymbol("map") }} />
      <NativeTab.Screen name="FeedTab" component={FeedTabScreen} options={{ title: "Feed", tabBarIcon: sfSymbol("rectangle.stack") }} />
      <NativeTab.Screen
        name="ChatTab"
        component={ChatTabScreen}
        options={{
          title: "Chat",
          tabBarIcon: sfSymbol("message"),
          tabBarBadge: dmPlusRoom > 0 ? dmPlusRoom : undefined,
        }}
      />
      <NativeTab.Screen name="PeopleTab" component={PeopleTabScreen} options={{ title: "People", tabBarIcon: sfSymbol("person.2") }} />
      <NativeTab.Screen
        name="ProfileTab"
        component={ProfileTabScreen}
        options={{
          title: "Profile",
          // A remote `{ uri }` source carries no intrinsic size the way a
          // bundled `require('./icon.png')` does — without an explicit
          // width/height, the native tab bar laid this out at the avatar
          // photo's actual fetched resolution instead of icon size,
          // ballooning it across the whole bar. 24pt matches the SF Symbol
          // icons on the other four tabs.
          tabBarIcon: avatarUrl
            ? { type: "image", source: { uri: avatarUrl, width: 24, height: 24 }, tinted: false }
            : sfSymbol("person.crop.circle"),
        }}
      />
    </NativeTab.Navigator>
  );
}
