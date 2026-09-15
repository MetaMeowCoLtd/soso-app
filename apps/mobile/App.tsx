import { StatusBar } from "expo-status-bar";
import { SafeAreaView, StyleSheet } from "react-native";

import MapScreen from "./src/map/MapScreen";

export default function App() {
  return (
    <SafeAreaView style={styles.flex1}>
      <MapScreen />
      <StatusBar style="dark" />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex1: { flex: 1 },
});
