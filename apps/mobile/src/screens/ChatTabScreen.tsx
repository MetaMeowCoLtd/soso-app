import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";

import type { RootStackParamList } from "../navigation/types";
import { Button } from "../ui/Button";
import { PlaceholderScreen } from "./PlaceholderScreen";

export default function ChatTabScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();

  return (
    <PlaceholderScreen title="Chat" checkpoint="C9">
      <Button label="Open DM thread" onPress={() => navigation.navigate("DmThreadView", { threadId: "demo-thread-1" })} />
      <Button label="New group" variant="secondary" onPress={() => navigation.navigate("NewGroupSheet")} />
    </PlaceholderScreen>
  );
}
