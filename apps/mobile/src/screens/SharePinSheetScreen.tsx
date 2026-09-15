import { useRoute, type RouteProp } from "@react-navigation/native";

import type { RootStackParamList } from "../navigation/types";
import { AppText } from "../ui/AppText";
import { PlaceholderScreen } from "./PlaceholderScreen";

export default function SharePinSheetScreen() {
  const { params } = useRoute<RouteProp<RootStackParamList, "SharePinSheet">>();

  return (
    <PlaceholderScreen title="Share" checkpoint="C8/C9">
      <AppText>postId: {params.postId}</AppText>
    </PlaceholderScreen>
  );
}
