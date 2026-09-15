import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";

import { useGateway } from "../gate/AppGate";
import type { RootStackParamList } from "../navigation/types";
import ConnectionsView from "../social/ConnectionsView";

export default function ConnectionsViewScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { params } = useRoute<RouteProp<RootStackParamList, "ConnectionsView">>();
  const gateway = useGateway();

  return (
    <ConnectionsView
      gateway={gateway}
      userId={params.userId}
      handle={params.handle}
      displayName={params.displayName}
      followers={params.followers}
      following={params.following}
      initialTab={params.initialTab}
      onClose={() => navigation.goBack()}
      onOpenProfile={(handle) => navigation.push("ProfileView", { handle })}
    />
  );
}
