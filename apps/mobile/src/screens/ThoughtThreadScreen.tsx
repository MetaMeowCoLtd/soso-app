import { useRoute, type RouteProp } from "@react-navigation/native";

import type { RootStackParamList } from "../navigation/types";
import { AppText } from "../ui/AppText";
import { PlaceholderScreen } from "./PlaceholderScreen";

/**
 * One screen for both of the web version's two ThoughtThread overlays
 * (pin thread vs. post comments) — see navigation/types.ts's comment on
 * why `mode` is a param rather than two separate routes.
 */
export default function ThoughtThreadScreen() {
  const { params } = useRoute<RouteProp<RootStackParamList, "ThoughtThread">>();

  return (
    <PlaceholderScreen title={params.mode === "comments" ? "Comments" : "Thread"} checkpoint="C7/C8">
      <AppText>postId: {params.postId}</AppText>
      <AppText>mode: {params.mode}</AppText>
    </PlaceholderScreen>
  );
}
