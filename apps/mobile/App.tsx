import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";

import StyleGallery from "./src/dev/StyleGallery";
import { Screen } from "./src/ui/Screen";

/**
 * C3 checkpoint: the theme tokens, icon set, and shared primitives built
 * this checkpoint, all visible on screen via StyleGallery. This replaces
 * C2's gateway-status banner and C1's bare map as App's content — neither
 * is lost, just not what's mounted right now; C1's MapScreen and C2's
 * gateway wiring get plugged back in properly once C5 builds real
 * navigation instead of one file standing in for the whole app shell.
 */
export default function App() {
  return (
    <SafeAreaProvider>
      <Screen>
        <StyleGallery />
      </Screen>
      <StatusBar style="dark" />
    </SafeAreaProvider>
  );
}
