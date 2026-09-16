import { useCallback, useEffect, useState } from "react";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { ActivityIndicator, View } from "react-native";

import { useGateway } from "../gate/AppGate";
import type { RootStackParamList } from "../navigation/types";
import ProfileView from "../social/ProfileView";
import { COLORS } from "../theme/tokens";

/**
 * The Profile tab — `variant="tab"` of the shared `ProfileView` (self,
 * no back button, "Edit profile" in place of Follow).
 *
 * `ProfileView` takes a handle and calls `gateway.userProfile(handle)` —
 * it has no notion of "whoever is signed in right now" on its own. Demo
 * mode's self-check happens to key on the literal string "demo_user"
 * (demo-gateway.ts's `myProfile`/`userProfile`), but that's an
 * implementation detail of ONE gateway, not something to hardcode here:
 * the real Supabase gateway resolves to whatever handle the signed-in
 * account actually chose at signup. `myProfile()` is what both gateways
 * already agree on for "who am I," so this resolves the handle from that
 * first, rather than assuming a demo-mode-only constant.
 *
 * `refreshToken` bumps on every focus rather than needing ProfileSettings
 * to signal back across two separate route components — navigating back
 * from Edit Profile refocuses this tab, which is exactly when a
 * just-saved name/bio needs to be picked up.
 */
export default function ProfileTabScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const gateway = useGateway();
  const [refreshToken, setRefreshToken] = useState(0);
  const [handle, setHandle] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      setRefreshToken((t) => t + 1);
    }, []),
  );

  useEffect(() => {
    let cancelled = false;
    gateway.myProfile().then((profile) => {
      // Null means signed out from under this screen (e.g. mid-session
      // token expiry) — nothing to show; the app-level auth gate is what
      // notices and routes back to sign-in, not this screen's job.
      if (!cancelled && profile) setHandle(profile.handle);
    });
    return () => {
      cancelled = true;
    };
  }, [gateway, refreshToken]);

  if (!handle) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: COLORS.surface }}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <ProfileView
      gateway={gateway}
      handle={handle}
      variant="tab"
      refreshToken={refreshToken}
      onEditProfile={() => navigation.navigate("ProfileSettings")}
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
      onOpenProfile={(otherHandle) => navigation.navigate("ProfileView", { handle: otherHandle })}
      onMessage={(userId) => {
        // No `getDmThread(id)` on SosoGateway — `openDmThread` is a
        // get-or-create, and its return is what DmThreadView needs. See
        // navigation/types.ts's own note on why the route takes a thread,
        // not an id.
        void gateway.openDmThread(userId).then((thread) => navigation.navigate("DmThreadView", { thread }));
      }}
    />
  );
}
