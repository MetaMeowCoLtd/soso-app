import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";

import { useAppGate } from "../gate/AppGate";
import { signOut } from "../data/auth";
import type { RootStackParamList } from "../navigation/types";
import { Button } from "../ui/Button";
import { AppText } from "../ui/AppText";
import { PlaceholderScreen } from "./PlaceholderScreen";

export default function ProfileTabScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { mode } = useAppGate();

  return (
    <PlaceholderScreen title="Profile" checkpoint="C8">
      <AppText>Gateway mode: {mode ?? "…"}</AppText>
      <Button label="Edit profile" onPress={() => navigation.navigate("ProfileSettings")} />
      {/* Exercises the AppGate's onAuthChange listener end to end: signing
          out here should flip the whole app back to the auth screens
          without any of this screen's own code deciding that — AppGate
          owns that transition. */}
      <Button label="Sign out" variant="secondary" onPress={() => void signOut()} />
    </PlaceholderScreen>
  );
}
