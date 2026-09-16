import { NavigationContainer } from "@react-navigation/native";
import { StatusBar } from "expo-status-bar";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";

import AuthScreens from "./src/auth/AuthScreens";
import { UnreadCountsProvider } from "./src/chat/UnreadCountsProvider";
import { AppGateProvider, useAppGate } from "./src/gate/AppGate";
import { RootNavigator } from "./src/navigation/RootNavigator";
import { PresenceProvider } from "./src/social/PresenceProvider";
import { COLORS } from "./src/theme/tokens";

/**
 * C5 checkpoint: App.tsx becomes the permanent app root rather than a
 * rotating checkpoint placeholder (C1's map, C2's gateway banner, C3's
 * style gallery, C4's bare auth screens all stood in for this in turn).
 * Provider order, outside in:
 *
 *  - SafeAreaProvider: needed by react-native-safe-area-context (src/ui/Screen.tsx, C3)
 *  - GestureHandlerRootView: react-navigation's own requirement once any
 *    screen uses gesture-handler — nothing does yet, but every native-stack
 *    screen transition already depends on it being present at the root.
 *  - AppGateProvider: resolves the gateway + account once (C2 + C4 logic,
 *    combined) and decides auth vs. ready.
 *  - NavigationContainer > RootNavigator: only mounted once ready, so the
 *    stack's initial route never flashes past whatever a not-yet-authed
 *    launch would have pushed.
 */
export default function App() {
  return (
    <SafeAreaProvider>
      <GestureHandlerRootView style={styles.flex1}>
        <AppGateProvider>
          <AppContent />
        </AppGateProvider>
        <StatusBar style="dark" />
      </GestureHandlerRootView>
    </SafeAreaProvider>
  );
}

function AppContent() {
  const { status, refreshAccount, continueAsGuest } = useAppGate();

  if (status.phase === "loading") {
    return (
      <View style={styles.centered}>
        <ActivityIndicator />
      </View>
    );
  }

  if (status.phase === "auth") {
    return (
      <View style={styles.flex1}>
        <AuthScreens account={status.account} onAuthenticated={refreshAccount} onSkip={continueAsGuest} />
      </View>
    );
  }

  return (
    <PresenceProvider>
      <UnreadCountsProvider>
        <NavigationContainer>
          <RootNavigator />
        </NavigationContainer>
      </UnreadCountsProvider>
    </PresenceProvider>
  );
}

const styles = StyleSheet.create({
  flex1: { flex: 1 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: COLORS.screenBackground },
});
