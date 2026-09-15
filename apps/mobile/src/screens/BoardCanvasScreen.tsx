import { useRoute, type RouteProp } from "@react-navigation/native";

import type { RootStackParamList } from "../navigation/types";
import { AppText } from "../ui/AppText";
import { PlaceholderScreen } from "./PlaceholderScreen";

export default function BoardCanvasScreen() {
  const { params } = useRoute<RouteProp<RootStackParamList, "BoardCanvas">>();

  return (
    <PlaceholderScreen title="Board" checkpoint="C11 (Skia canvas)">
      <AppText>pinId: {params.pinId}</AppText>
    </PlaceholderScreen>
  );
}
