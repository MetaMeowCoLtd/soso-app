import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { SafeAreaView, StyleSheet, Text, View } from "react-native";

import MapScreen from "./src/map/MapScreen";
import { resolveGateway, type GatewayMode } from "./src/data/bootstrap";

/**
 * C2 checkpoint: exercises the full gateway chain end to end — this file's
 * import of bootstrap.ts pulls in supabase.ts (AsyncStorage-backed client)
 * and demo-gateway.ts (AsyncStorage-backed local fallback), both of which
 * import packages/core via the relative path in src/core.ts. The status
 * banner is deliberately minimal; it exists to make the resolved mode and
 * category count visible on screen rather than only in a console log, and
 * gets replaced by real navigation in C5.
 */
function useGatewayStatus() {
  const [status, setStatus] = useState<{ mode: GatewayMode; categoryCount: number } | { error: string } | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    resolveGateway()
      .then(async ({ gateway, mode }) => {
        const categories = await gateway.loadCategories();
        if (!cancelled) setStatus({ mode, categoryCount: categories.length });
      })
      .catch((err: unknown) => {
        if (!cancelled) setStatus({ error: err instanceof Error ? err.message : "Gateway failed to resolve" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return status;
}

export default function App() {
  const gatewayStatus = useGatewayStatus();

  return (
    <SafeAreaView style={styles.flex1}>
      <MapScreen />
      <View style={styles.statusBar} pointerEvents="none">
        <Text style={styles.statusText}>
          {gatewayStatus === null
            ? "Resolving gateway…"
            : "error" in gatewayStatus
              ? `Gateway error: ${gatewayStatus.error}`
              : `Gateway: ${gatewayStatus.mode} (${gatewayStatus.categoryCount} categories)`}
        </Text>
      </View>
      <StatusBar style="dark" />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex1: { flex: 1 },
  statusBar: {
    position: "absolute",
    bottom: 24,
    left: 16,
    right: 16,
    backgroundColor: "rgba(23, 36, 31, 0.85)",
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  statusText: { color: "#fdf3e6", fontSize: 13, textAlign: "center" },
});
