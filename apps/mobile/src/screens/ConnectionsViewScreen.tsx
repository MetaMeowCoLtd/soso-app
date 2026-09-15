import { useRoute, type RouteProp } from "@react-navigation/native";

import type { RootStackParamList } from "../navigation/types";
import { AppText } from "../ui/AppText";
import { PlaceholderScreen } from "./PlaceholderScreen";

export default function ConnectionsViewScreen() {
  const { params } = useRoute<RouteProp<RootStackParamList, "ConnectionsView">>();

  return (
    <PlaceholderScreen title="Connections" checkpoint="C8">
      <AppText>userId: {params.userId}</AppText>
      <AppText>initialTab: {params.initialTab ?? "(default)"}</AppText>
    </PlaceholderScreen>
  );
}
