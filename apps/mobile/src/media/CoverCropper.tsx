import { Image, Modal, StyleSheet, View } from "react-native";
import { GestureDetector } from "react-native-gesture-handler";

import { clampCoverOffset, coverCoverScale, coverCropRect, COVER_MAX_ZOOM, type CoverCrop } from "../core";
import { COLORS } from "../theme/tokens";
import { AppText } from "../ui/AppText";
import { Button } from "../ui/Button";
import { useCropGestures } from "./useCropGestures";
import type { DecodedAvatarImage } from "./AvatarCropper";

/** The cover-photo counterpart of AvatarCropper.tsx — same gesture hook, cover.ts's own (non-square) geometry. See COVER_CROP_ASPECT_RATIO's own comment for why 3:1. */
const VIEWPORT_WIDTH = 320;
const VIEWPORT_HEIGHT = VIEWPORT_WIDTH / 3;

export default function CoverCropper({
  image,
  busy,
  onConfirm,
  onCancel,
}: {
  image: DecodedAvatarImage;
  busy: boolean;
  onConfirm: (crop: CoverCrop) => void;
  onCancel: () => void;
}) {
  const coverScale = coverCoverScale(image.width, image.height, VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
  const { scale, offset, gesture } = useCropGestures({
    coverScale,
    clampOffset: (o, s) => clampCoverOffset(o, image.width, image.height, s, VIEWPORT_WIDTH, VIEWPORT_HEIGHT),
    maxZoom: COVER_MAX_ZOOM,
    viewportWidth: VIEWPORT_WIDTH,
    viewportHeight: VIEWPORT_HEIGHT,
  });

  function confirm() {
    onConfirm(coverCropRect(image.width, image.height, scale, offset, VIEWPORT_WIDTH, VIEWPORT_HEIGHT));
  }

  return (
    <Modal visible transparent animationType="fade">
      <View style={styles.scrim}>
        <View style={styles.panel}>
          <AppText style={styles.title}>Crop your cover photo</AppText>

          <GestureDetector gesture={gesture}>
            <View style={[styles.viewport, { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT }]}>
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
  panel: { backgroundColor: COLORS.glass, borderRadius: 20, padding: 20, gap: 16, alignItems: "center" },
  title: { fontWeight: "700", fontSize: 15 },
  viewport: { overflow: "hidden", backgroundColor: "#000000", borderRadius: 12 },
  hint: { fontSize: 12, color: COLORS.muted },
  actions: { flexDirection: "row", gap: 12 },
});
