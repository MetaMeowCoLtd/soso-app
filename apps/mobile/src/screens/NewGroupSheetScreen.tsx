import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";

import NewGroupSheet from "../chat/NewGroupSheet";
import { useGateway } from "../gate/AppGate";
import type { RootStackParamList } from "../navigation/types";
import { usePresenceContext } from "../social/PresenceProvider";

export default function NewGroupSheetScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const gateway = useGateway();
  const { friends } = usePresenceContext();

  return (
    <NewGroupSheet
      gateway={gateway}
      friends={friends}
      onCreated={(thread) => navigation.replace("DmThreadView", { thread })}
      onOpenDirect={(userId) => {
        void gateway.openDmThread(userId).then((thread) => navigation.replace("DmThreadView", { thread }));
      }}
      onClose={() => navigation.goBack()}
    />
  );
}
