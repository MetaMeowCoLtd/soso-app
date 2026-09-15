import { Image, Modal, Pressable, StyleSheet, View } from "react-native";

import { Icon, ICONS } from "../theme/Icon";
import { AppText } from "../ui/AppText";

/**
 * Ported from apps/web/src/web/AvatarViewer.tsx. Shows the square the
 * person actually cropped — not another circle, which would just be a
 * bigger version of the same crop and defeat the point of "view it larger."
 * Escape-to-close and focus restore have no RN equivalent (no keyboard,
 * no DOM focus) — a `Modal`'s hardware-back dismissal on Android and the
 * explicit close button cover the same "get out of this" need.
 */
interface AvatarViewerProps {
  /** Already resolved by the caller — see `SosoGateway.avatarUrl`. */
  src: string;
  name: string;
  handle?: string | null;
  onClose: () => void;
}

export default function AvatarViewer({ src, name, handle, onClose }: AvatarViewerProps) {
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.closeButton} onPress={onClose} accessibilityLabel="Close">
          <Icon src={ICONS.close} size={18} color="#ffffff" />
        </Pressable>
        <View style={styles.figure} onStartShouldSetResponder={() => true}>
          <Image source={{ uri: src }} style={styles.image} accessibilityLabel={`${name}'s profile photo`} />
          <AppText style={styles.name}>{name}</AppText>
          {handle && <AppText style={styles.handle}>@{handle}</AppText>}
        </View>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.85)", alignItems: "center", justifyContent: "center" },
  closeButton: { position: "absolute", top: 56, right: 20, padding: 10 },
  figure: { alignItems: "center", gap: 8 },
  image: { width: 300, height: 300, borderRadius: 12 },
  name: { color: "#ffffff", fontWeight: "700", fontSize: 16, marginTop: 8 },
  handle: { color: "rgba(255,255,255,0.7)", fontSize: 13 },
});
