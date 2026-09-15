import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";

import type { RootStackParamList } from "../navigation/types";
import { Button } from "../ui/Button";
import { PlaceholderScreen } from "./PlaceholderScreen";

const DEMO_PIN_ID = "demo-pin-1";

/**
 * Map tab. Unlike every other tab, this one keeps `unmountOnBlur: false`
 * in TabNavigator.tsx — see that file's comment on why: the web version's
 * map tab owns the composer and the location subscription and is the one
 * tab CSS-hides rather than unmounts (app/page.tsx:197-203).
 */
export default function MapTabScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();

  return (
    <PlaceholderScreen title="Map" checkpoint="C6 (pins) and C11 (board canvas)">
      <Button label="Open board" onPress={() => navigation.navigate("BoardCanvas", { pinId: DEMO_PIN_ID })} />
      <Button
        label="Open pin thread"
        variant="secondary"
        onPress={() => navigation.navigate("ThoughtThread", { postId: DEMO_PIN_ID, mode: "post" })}
      />
      <Button
        label="Share pin"
        variant="secondary"
        onPress={() => navigation.navigate("SharePinSheet", { postId: DEMO_PIN_ID })}
      />
    </PlaceholderScreen>
  );
}
