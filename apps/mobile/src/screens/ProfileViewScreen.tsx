import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";

import { useGateway } from "../gate/AppGate";
import type { RootStackParamList } from "../navigation/types";
import ProfileView from "../social/ProfileView";

/** Another person's profile, pushed from a tapped byline — `variant="overlay"` of the shared ProfileView. Self profile is the Profile tab, not this route. */
export default function ProfileViewScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { params } = useRoute<RouteProp<RootStackParamList, "ProfileView">>();
  const gateway = useGateway();

  return (
    <ProfileView
      gateway={gateway}
      handle={params.handle}
      variant="overlay"
      onClose={() => navigation.goBack()}
      onOpenPost={(postId) => navigation.navigate("ThoughtThread", { postId, mode: "post" })}
      onOpenComments={(postId) => navigation.navigate("ThoughtThread", { postId, mode: "comments" })}
      onOpenConnections={(profile, tab) =>
        navigation.navigate("ConnectionsView", {
          userId: profile.id,
          handle: profile.handle,
          displayName: profile.displayName,
          followers: profile.followers,
          following: profile.following,
          initialTab: tab,
        })
      }
      onOpenProfile={(handle) => navigation.push("ProfileView", { handle })}
      onMessage={(userId) => navigation.navigate("DmThreadView", { threadId: userId })}
    />
  );
}
