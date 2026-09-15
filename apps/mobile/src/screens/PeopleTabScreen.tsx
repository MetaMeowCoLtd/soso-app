import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";

import type { RootStackParamList } from "../navigation/types";
import { Button } from "../ui/Button";
import { PlaceholderScreen } from "./PlaceholderScreen";

export default function PeopleTabScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();

  return (
    <PlaceholderScreen title="People" checkpoint="C8">
      <Button label="View profile" onPress={() => navigation.navigate("ProfileView", { handle: "demo_user" })} />
      <Button
        label="View connections"
        variant="secondary"
        onPress={() => navigation.navigate("ConnectionsView", { userId: "demo", initialTab: "followers" })}
      />
    </PlaceholderScreen>
  );
}
