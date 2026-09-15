import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";

import { useAppGate, useGateway } from "../gate/AppGate";
import type { RootStackParamList } from "../navigation/types";
import { usePresenceContext } from "../social/PresenceProvider";
import ProfileSettings from "../social/ProfileSettings";

export default function ProfileSettingsScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const gateway = useGateway();
  const { mode } = useAppGate();
  const presence = usePresenceContext();

  return (
    <ProfileSettings
      gateway={gateway}
      demoMode={mode === "demo"}
      presenceSharing={presence.sharing}
      onTogglePresence={presence.setSharing}
      onClose={() => navigation.goBack()}
      onSaved={() => {
        presence.refreshMe();
      }}
    />
  );
}
