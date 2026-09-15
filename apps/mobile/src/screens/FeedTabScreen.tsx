import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";

import type { RootStackParamList } from "../navigation/types";
import { Button } from "../ui/Button";
import { PlaceholderScreen } from "./PlaceholderScreen";

export default function FeedTabScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();

  return (
    <PlaceholderScreen title="Feed" checkpoint="C8">
      <Button
        label="Open comments"
        onPress={() => navigation.navigate("ThoughtThread", { postId: "demo-feed-1", mode: "comments" })}
      />
    </PlaceholderScreen>
  );
}
