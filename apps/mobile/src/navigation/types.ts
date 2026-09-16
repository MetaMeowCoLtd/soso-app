import type { NavigatorScreenParams } from "@react-navigation/native";

import type { DmThread } from "../core";

/**
 * The five bottom tabs, matching apps/web's `activeTab` union
 * (app/page.tsx:204: `"map" | "feed" | "chat" | "people" | "profile"`).
 * No params on any tab — each tab screen owns its own internal state, the
 * same way the web version's tab content does.
 */
export type TabParamList = {
  MapTab: undefined;
  FeedTab: undefined;
  ChatTab: undefined;
  PeopleTab: undefined;
  ProfileTab: undefined;
};

/**
 * Everything that was a boolean/nullable-gated full-screen overlay in
 * apps/web's app/page.tsx (lines 1324-1686), now real stack routes pushed
 * over the tabs. `onClose` in the web version becomes `navigation.goBack()`
 * at each of these call sites once C6-C11 give them real content.
 *
 * ThoughtThread carries a `mode` param rather than being two routes,
 * mirroring the web version's own reuse of one `ThoughtThread` component
 * for both the pin-thread overlay and the comments overlay.
 */
export type RootStackParamList = {
  Tabs: NavigatorScreenParams<TabParamList>;
  BoardCanvas: { pinId: string };
  ThoughtThread: { postId: string; mode: "post" | "comments" };
  ProfileView: { handle: string };
  /**
   * Carries the header info (handle/displayName/counts) the web version's
   * `ConnectionsView` takes as props from the profile that opened it —
   * `onOpenConnections(profile, tab)` in ProfileView.tsx — rather than just
   * a bare userId, so the screen doesn't refetch a profile it was just
   * shown for header text alone.
   */
  ConnectionsView: {
    userId: string;
    handle: string;
    displayName: string;
    followers: number;
    following: number;
    initialTab: "followers" | "following";
  };
  ProfileSettings: undefined;
  SharePinSheet: { postId: string };
  NewGroupSheet: undefined;
  /**
   * Carries the resolved `DmThread` object itself, not just an id — there
   * is no `getDmThread(id)` on `SosoGateway` (only `listDmThreads()`, plus
   * the mutators that happen to return one), so whoever navigates here has
   * always already gotten hold of the thread some other way: a row tapped
   * in DmInbox, or `gateway.openDmThread(userId)` resolved right before
   * navigating (see ProfileViewScreen/PeopleTabScreen/NewGroupSheet's
   * "Message" paths). Mirrors ConnectionsView's identical choice just
   * above, for the identical reason.
   */
  DmThreadView: { thread: DmThread };
};

declare global {
  namespace ReactNavigation {
    interface RootParamList extends RootStackParamList {}
  }
}
