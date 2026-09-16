import { Image, Modal, StyleSheet, View } from "react-native";
import { GestureDetector } from "react-native-gesture-handler";

import { avatarCoverScale, avatarCropRect, clampAvatarOffset, AVATAR_MAX_ZOOM, type SquareCrop } from "../core";
import { COLORS } from "../theme/tokens";
import { AppText } from "../ui/AppText";
import { Button } from "../ui/Button";
import { useCropGestures } from "./useCropGestures";

/**
 * Ported from apps/web/src/web/AvatarCropper.tsx. The geometry —
 * `avatarCoverScale`, `clampAvatarOffset`, `avatarCropRect`, all of
 * `avatar.ts` — is pure core logic and moves completely unchanged; only
 * the pointer/wheel handling that PRODUCES `scale`/`offset` is rebuilt, on
 * `react-native-gesture-handler` via `useCropGestures` (see that file for
 * why it runs on the JS thread rather than as a worklet).
 *
 * NO ZOOM SLIDER. The web version's exists for a mouse, which has no pinch
 * gesture of its own — every device this runs on does, so pinch-to-zoom is
 * the native control rather than a second one duplicating it, and adding a
 * slider dependency to offer a redundant path to the same thing isn't
 * worth it.
 */
const VIEWPORT = 280;

export interface DecodedAvatarImage {
  uri: string;
  width: number;
  height: number;
}

export default function AvatarCropper({
  image,
  busy,
  onConfirm,
  onCancel,
}: {
  image: DecodedAvatarImage;
  busy: boolean;
  onConfirm: (crop: SquareCrop) => void;
  onCancel: () => void;
}) {
  const coverScale = avatarCoverScale(image.width, image.height, VIEWPORT);
  const { scale, offset, gesture } = useCropGestures({
    coverScale,
    clampOffset: (o, s) => clampAvatarOffset(o, image.width, image.height, s, VIEWPORT),
    maxZoom: AVATAR_MAX_ZOOM,
    viewportWidth: VIEWPORT,
    viewportHeight: VIEWPORT,
  });

  function confirm() {
    onConfirm(avatarCropRect(image.width, image.height, scale, offset, VIEWPORT));
  }

  return (
    <Modal visible transparent animationType="fade">
      <View style={styles.scrim}>
        <View style={styles.panel}>
          <AppText style={styles.title}>Crop your photo</AppText>

          <View style={styles.viewportWrap}>
            <GestureDetector gesture={gesture}>
              <View style={[styles.viewport, { width: VIEWPORT, height: VIEWPORT, borderRadius: VIEWPORT / 2 }]}>
                <Image
                  source={{ uri: image.uri }}
                  style={{
                    position: "absolute",
                    left: offset.x,
                    top: offset.y,
                    width: image.width * scale,
                    height: image.height * scale,
                  }}
                />
              </View>
            </GestureDetector>
          </View>

          <AppText style={styles.hint}>Pinch to zoom, drag to reposition</AppText>

          <View style={styles.actions}>
            <Button label="Cancel" variant="secondary" onPress={onCancel} disabled={busy} />
            <Button label={busy ? "Saving…" : "Use photo"} onPress={confirm} disabled={busy} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: "rgba(10,20,17,0.6)", alignItems: "center", justifyContent: "center" },
  panel: { backgroundColor: COLORS.glass, borderRadius: 20, padding: 20, gap: 16, width: 320, alignItems: "center" },
  title: { fontWeight: "700", fontSize: 15 },
  viewportWrap: { alignItems: "center", justifyContent: "center" },
  viewport: { overflow: "hidden", backgroundColor: "#000000" },
  hint: { fontSize: 12, color: COLORS.muted },
  actions: { flexDirection: "row", gap: 12 },
});
