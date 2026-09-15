import { useRoute, type RouteProp } from "@react-navigation/native";

import type { RootStackParamList } from "../navigation/types";
import { AppText } from "../ui/AppText";
import { PlaceholderScreen } from "./PlaceholderScreen";

/** Another person's profile, pushed from a tapped byline. Self profile is a tab, not this route — see ProfileTabScreen. */
export default function ProfileViewScreen() {
  const { params } = useRoute<RouteProp<RootStackParamList, "ProfileView">>();

  return (
    <PlaceholderScreen title="Profile" checkpoint="C8">
      <AppText>handle: @{params.handle}</AppText>
    </PlaceholderScreen>
  );
}
