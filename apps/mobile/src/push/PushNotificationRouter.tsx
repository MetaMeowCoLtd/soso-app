import * as Notifications from "expo-notifications";
import { useEffect } from "react";

import { useGateway } from "../gate/AppGate";
import { openDeepLink } from "./notificationNavigation";

/**
 * Shows a banner for a notification that arrives while the app is already
 * open — set once at module scope, same as every `expo-notifications`
 * example does it, since there is exactly one handler for the whole app
 * and no per-screen reason to reconfigure it.
 */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

/**
 * Mounted once near the root (see App.tsx) — the RN equivalent of sw.js's
 * `notificationclick` listener, plus the one thing a service worker never
 * had to handle itself: a notification that was tapped to COLD-START the
 * app, where the listener below has nothing to catch because it did not
 * exist yet when the tap happened. `getLastNotificationResponseAsync()` is
 * exactly the native answer to that — the same role sw.js's fallback
 * `?post=` URL played for a cold web load.
 */
export function PushNotificationRouter(): null {
  const gateway = useGateway();

  useEffect(() => {
    void Notifications.getLastNotificationResponseAsync().then((response) => {
      const data = response?.notification.request.content.data;
      if (data) void openDeepLink(gateway, data);
    });

    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data;
      if (data) void openDeepLink(gateway, data);
    });
    return () => subscription.remove();
  }, [gateway]);

  return null;
}
