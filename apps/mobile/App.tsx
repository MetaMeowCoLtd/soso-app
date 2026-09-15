import { StatusBar } from "expo-status-bar";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import AuthScreens from "./src/auth/AuthScreens";
import { ensureGuestSession } from "./src/data/auth";
import { AppText } from "./src/ui/AppText";
import { Screen } from "./src/ui/Screen";
import { COLORS } from "./src/theme/tokens";

/**
 * C4 checkpoint: the phone-OTP auth screens on device. Without real
 * Supabase credentials configured (EXPO_PUBLIC_SUPABASE_URL/_ANON_KEY),
 * submitting a phone number will honestly fail with "couldn't reach the
 * server" — sendCode's own try/catch turns getSupabase()'s synchronous
 * throw into that error rather than a crash, which is the same fallback
 * behaviour the web app has. That still exercises the full state machine
 * (phone -> code -> handle) and every screen's render path; a real SMS
 * round trip needs real credentials, which is a deployment concern, not a
 * C4 one.
 *
 * Replaces C3's StyleGallery as App's content — see that file's note; C5
 * is where a real navigator, not this file, decides what's on screen.
 */
export default function App() {
  const [authenticated, setAuthenticated] = useState(false);

  return (
    <SafeAreaProvider>
      <Screen>
        {authenticated ? (
          <View style={styles.center}>
            <AppText style={styles.done}>Authenticated ✓</AppText>
          </View>
        ) : (
          <AuthScreens
            account={null}
            onAuthenticated={() => setAuthenticated(true)}
            onSkip={async () => {
              const ok = await ensureGuestSession();
              if (ok) setAuthenticated(true);
            }}
          />
        )}
      </Screen>
      <StatusBar style="dark" />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  done: { fontSize: 20, fontWeight: "700", color: COLORS.teal },
});
