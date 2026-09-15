import { useRoute, type RouteProp } from "@react-navigation/native";

import type { RootStackParamList } from "../navigation/types";
import { AppText } from "../ui/AppText";
import { PlaceholderScreen } from "./PlaceholderScreen";

export default function DmThreadViewScreen() {
  const { params } = useRoute<RouteProp<RootStackParamList, "DmThreadView">>();

  return (
    <PlaceholderScreen title="Conversation" checkpoint="C9">
      <AppText>threadId: {params.threadId}</AppText>
    </PlaceholderScreen>
  );
}
