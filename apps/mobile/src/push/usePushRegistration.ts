import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Location from "expo-location";
import * as Notifications from "expo-notifications";
import { useCallback, useEffect, useState } from "react";
import { Platform } from "react-native";

import type { SosoGateway } from "../core";
import { nearbyCellIds } from "./nearbyCellIds";

/**
 * The native counterpart of apps/web/src/web/push.ts — and considerably
 * smaller, for the same reason `notify-new-pin`'s own header gives for the
 * sending side: a native app has no `PushAvailability` three-state model to
 * compute (there's no "not installed as a PWA yet" state — the app is
 * always installed), no service worker to register, and no VAPID key to
 * turn into a `BufferSource`. Requesting permission and asking
 * `expo-notifications` for a token is the whole subscribe step; Expo's own
 * push service is what turns that token into a real APNs/FCM delivery.
 *
 * PERSISTED SO THE SETTINGS TOGGLE REFLECTS REALITY ACROSS A RELAUNCH,
 * without re-requesting permission or re-registering every time this
 * screen mounts — `Notifications.requestPermissionsAsync()` is safe to
 * call repeatedly (it only prompts once, ever), but it's still one native
 * round trip this hook can skip when it already knows the answer.
 */

const ENABLED_KEY = "soso:push-enabled:v1";
const TOKEN_KEY = "soso:push-token:v1";

export interface PushRegistration {
  enabled: boolean;
  busy: boolean;
  error: string | null;
  /** Undefined on web, or before `expo-device` has had a chance to say — `false` once it's certain this is a simulator/emulator. */
  supported: boolean;
  enable: () => void;
  disable: () => void;
}

export function usePushRegistration(gateway: SosoGateway): PushRegistration {
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void AsyncStorage.getItem(ENABLED_KEY).then((v) => setEnabled(v === "true"));
  }, []);

  const enable = useCallback(() => {
    void (async () => {
      setBusy(true);
      setError(null);
      try {
        // A push token minted on a simulator/emulator is fake and cannot be
        // delivered to — asking anyway just produces a confusing failure
        // later, at send time, instead of an honest one now.
        if (!Device.isDevice) {
          throw new Error("Push notifications need a real device — the simulator can't receive them.");
        }

        const permission = await Notifications.requestPermissionsAsync();
        if (permission.status !== "granted") {
          throw new Error("Notifications are turned off for Soso. Enable them in Settings to turn this on.");
        }

        const projectId = Constants.expoConfig?.extra?.eas?.projectId as string | undefined;
        const { data: token } = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);

        // A best-effort centre for the "nearby" area this subscribes to.
        // Not the strict, high-accuracy fix ReportForm needs for its
        // proximity gate — a push area is a ~3km neighbourhood, not a
        // single spot, so the device's last-known fix (instant, no GPS
        // warm-up) is precise enough and doesn't need a fresh one.
        const { status: locationStatus } = await Location.requestForegroundPermissionsAsync();
        if (locationStatus !== "granted") {
          throw new Error("Soso needs your location to know which area to notify you about.");
        }
        const last = await Location.getLastKnownPositionAsync();
        const position = last ?? (await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Low }));
        const cellIds = nearbyCellIds(position.coords.longitude, position.coords.latitude);

        await gateway.subscribeToNativePush({ token, platform: Platform.OS as "ios" | "android" }, cellIds);

        await AsyncStorage.setItem(TOKEN_KEY, token);
        await AsyncStorage.setItem(ENABLED_KEY, "true");
        setEnabled(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't turn on notifications. Try again.");
      } finally {
        setBusy(false);
      }
    })();
  }, [gateway]);

  const disable = useCallback(() => {
    void (async () => {
      setBusy(true);
      setError(null);
      try {
        const token = await AsyncStorage.getItem(TOKEN_KEY);
        if (token) await gateway.unsubscribeFromNativePush(token);
        await AsyncStorage.removeItem(TOKEN_KEY);
        await AsyncStorage.setItem(ENABLED_KEY, "false");
        setEnabled(false);
      } catch {
        setError("Couldn't turn that off. Try again.");
      } finally {
        setBusy(false);
      }
    })();
  }, [gateway]);

  return { enabled, busy, error, supported: Device.isDevice, enable, disable };
}
