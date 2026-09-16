import { createNativeStackNavigator } from "@react-navigation/native-stack";

import BoardCanvasScreen from "../screens/BoardCanvasScreen";
import ConnectionsViewScreen from "../screens/ConnectionsViewScreen";
import DmThreadViewScreen from "../screens/DmThreadViewScreen";
import NewGroupSheetScreen from "../screens/NewGroupSheetScreen";
import ProfileSettingsScreen from "../screens/ProfileSettingsScreen";
import ProfileViewScreen from "../screens/ProfileViewScreen";
import SharePinSheetScreen from "../screens/SharePinSheetScreen";
import ThoughtThreadScreen from "../screens/ThoughtThreadScreen";
import { TabNavigator } from "./TabNavigator";
import type { RootStackParamList } from "./types";

const Stack = createNativeStackNavigator<RootStackParamList>();

/**
 * The root stack: the tab bar as its initial route, plus every route that
 * was a boolean/nullable-gated full-screen overlay in apps/web's
 * app/page.tsx (13 of them, at app/page.tsx:1324-1686) — depth there was
 * managed by CSS z-index with, in that file's own words, "no navigation
 * stack here to come back to." This is that stack.
 *
 * Android hardware back needs no custom handling here: NavigationContainer
 * (in App.tsx) already wires the hardware back button to pop the top of
 * this stack by default, and to do nothing extra when there's nothing left
 * to pop — exactly the behaviour the web version has no equivalent of at
 * all. Nothing here overrides that default because the default is already
 * what's wanted.
 */
export function RootNavigator() {
  return (
    <Stack.Navigator>
      <Stack.Screen name="Tabs" component={TabNavigator} options={{ headerShown: false }} />
      <Stack.Screen name="BoardCanvas" component={BoardCanvasScreen} options={{ title: "Board" }} />
      {/* These six already render their own header (back/close button,
          title, and — for ProfileSettings/NewGroupSheet — a Save/Create
          action) to match the web app's own modal-style headers. Without
          `headerShown: false`, native-stack's default header rendered on
          top of that, so every one of these screens showed two header bars
          stacked, with the real title/action buttons squeezed or hidden
          beneath the plain native one. ThoughtThread's own header title
          depends on `params.mode` ("Thread" vs "Comments"), which the
          native header's static `options.title` has no way to express. */}
      <Stack.Screen name="ThoughtThread" component={ThoughtThreadScreen} options={{ headerShown: false }} />
      <Stack.Screen name="ProfileView" component={ProfileViewScreen} options={{ headerShown: false }} />
      <Stack.Screen name="ConnectionsView" component={ConnectionsViewScreen} options={{ headerShown: false }} />
      <Stack.Screen name="ProfileSettings" component={ProfileSettingsScreen} options={{ headerShown: false }} />
      <Stack.Screen name="SharePinSheet" component={SharePinSheetScreen} options={{ title: "Share", presentation: "modal" }} />
      <Stack.Screen name="NewGroupSheet" component={NewGroupSheetScreen} options={{ headerShown: false, presentation: "modal" }} />
      <Stack.Screen name="DmThreadView" component={DmThreadViewScreen} options={{ headerShown: false }} />
    </Stack.Navigator>
  );
}
