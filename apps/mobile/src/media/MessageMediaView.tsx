import { useVideoPlayer, VideoView } from "expo-video";
import { useEffect, useState } from "react";
import { ActivityIndicator, Image, Modal, Pressable, StyleSheet, View } from "react-native";

import { messageImageDisplaySize, type MessageMedia, type SosoGateway } from "../core";
import { Icon, ICONS } from "../theme/Icon";
import { COLORS } from "../theme/tokens";
import { AppText } from "../ui/AppText";
import { saveMessageMedia } from "./saveMedia";
import { useMessageImageUrl } from "./useMessageImageUrl";

/**
 * Ported from apps/web/src/web/MessageMediaView.tsx — one image/video in a
 * message bubble, poster-first for a clip, full viewer on tap.
 *
 * DROPPED: `AutoplayVideo`'s scroll-into-view autoplay. That feature is
 * genuinely web-specific in its motivation as much as its mechanism — the
 * source's own module comment justifies it by naming a cost ("this DOES
 * fetch the clip for every video that scrolls into view") it accepts only
 * because IntersectionObserver makes detecting "in view" free. Doing the
 * same on a `FlatList` means `onViewableItemsChanged` plus per-row state
 * threaded back up to whichever screen owns the list, to autoplay MUTED
 * clips nobody asked to see — a real feature, but a bigger one than
 * "render an attachment," and this checkpoint's job is the pipeline, not a
 * new interaction. Tap-to-open is the fallback path on web too (a reply
 * quote, the long-press sheet's clone); it is simply the ONLY path here.
 */
export function MessageMediaView({
  gateway,
  image,
  availableWidth = 220,
  maxHeight = 260,
  onOpen,
}: {
  gateway: SosoGateway;
  image: MessageMedia;
  availableWidth?: number;
  maxHeight?: number;
  /** Omitted where a thumbnail isn't tappable (a reply quote). */
  onOpen?: () => void;
}) {
  const isVideo = image.kind === "video";
  const thumbPath = isVideo ? image.posterPath! : image.path;
  const { url, loading } = useMessageImageUrl(gateway, thumbPath);
  const size = messageImageDisplaySize(image, availableWidth, maxHeight);
  const [failed, setFailed] = useState(false);

  const style = { width: size.width, height: size.height };

  if (loading) {
    return (
      <View style={[styles.box, style]}>
        <ActivityIndicator size="small" />
      </View>
    );
  }

  if (!url || failed) {
    return (
      <View style={[styles.box, style]}>
        <AppText style={styles.missingText}>{isVideo ? "Video unavailable" : "Image unavailable"}</AppText>
      </View>
    );
  }

  return (
    <Pressable style={[styles.box, style]} onPress={onOpen} disabled={!onOpen}>
      <ThumbImage uri={url} onError={() => setFailed(true)} />
      {isVideo && (
        <>
          <View style={styles.playBadge}>
            <Icon src={ICONS.play} size={20} color="#ffffff" />
          </View>
          {image.durationMs !== null && (
            <View style={styles.durationBadge}>
              <AppText style={styles.durationText}>{formatClipLength(image.durationMs)}</AppText>
            </View>
          )}
        </>
      )}
    </Pressable>
  );
}

function ThumbImage({ uri, onError }: { uri: string; onError: () => void }) {
  return <Image source={{ uri }} style={styles.fill} onError={onError} />;
}

function formatClipLength(durationMs: number): string {
  const total = Math.max(0, Math.round(durationMs / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * Full-screen viewer, opened by tapping a bubble's attachment. Resolves
 * its own URLs (poster immediately, the clip itself only once opened) via
 * the same `useMessageImageUrl` the thumbnail used — see that hook's own
 * note on why post and message media share it.
 */
export function MessageMediaLightbox({
  visible,
  media,
  gateway,
  onClose,
}: {
  visible: boolean;
  media: MessageMedia;
  gateway: SosoGateway;
  onClose: () => void;
}) {
  const posterPath = media.kind === "video" ? media.posterPath! : media.path;
  const { url: posterUrl } = useMessageImageUrl(gateway, posterPath);
  const { url: clipUrl } = useMessageImageUrl(gateway, media.kind === "video" ? media.path : null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const player = useVideoPlayer(media.kind === "video" ? clipUrl : null);
  useEffect(() => {
    if (media.kind === "video" && clipUrl) player.play();
  }, [clipUrl, media.kind, player]);

  async function save() {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await saveMessageMedia(gateway, media);
    } catch {
      setError("Couldn't save that. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.lightbox}>
        <View style={styles.lightboxActions}>
          <Pressable onPress={() => void save()} disabled={saving} style={styles.lightboxAction} accessibilityLabel="Save">
            <Icon src={ICONS.download} size={20} color="#ffffff" />
          </Pressable>
          <Pressable onPress={onClose} style={styles.lightboxAction} accessibilityLabel="Close">
            <Icon src={ICONS.close} size={16} color="#ffffff" />
          </Pressable>
        </View>

        {media.kind === "video" ? (
          clipUrl ? (
            <VideoView style={styles.lightboxMedia} player={player} nativeControls contentFit="contain" />
          ) : posterUrl ? (
            <ThumbImage uri={posterUrl} onError={() => {}} />
          ) : null
        ) : posterUrl ? (
          <View style={styles.lightboxImageWrap}>
            <ThumbImage uri={posterUrl} onError={() => {}} />
          </View>
        ) : null}

        {error && <AppText style={styles.lightboxError}>{error}</AppText>}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  box: { borderRadius: 14, overflow: "hidden", backgroundColor: "rgba(0,0,0,0.08)", alignItems: "center", justifyContent: "center" },
  fill: { width: "100%", height: "100%" },
  missingText: { fontSize: 12, color: COLORS.muted },
  playBadge: { position: "absolute", width: 44, height: 44, borderRadius: 22, backgroundColor: "rgba(0,0,0,0.45)", alignItems: "center", justifyContent: "center" },
  durationBadge: { position: "absolute", right: 6, bottom: 6, backgroundColor: "rgba(0,0,0,0.6)", borderRadius: 6, paddingHorizontal: 5, paddingVertical: 1 },
  durationText: { color: "#ffffff", fontSize: 11 },
  lightbox: { flex: 1, backgroundColor: "rgba(0,0,0,0.92)", alignItems: "center", justifyContent: "center" },
  lightboxActions: { position: "absolute", top: 48, right: 16, flexDirection: "row", gap: 12, zIndex: 1 },
  lightboxAction: { width: 40, height: 40, borderRadius: 20, backgroundColor: "rgba(255,255,255,0.15)", alignItems: "center", justifyContent: "center" },
  lightboxMedia: { width: "100%", height: "70%" },
  lightboxImageWrap: { width: "100%", height: "70%" },
  lightboxError: { position: "absolute", bottom: 40, color: "#ffffff", fontSize: 13 },
});
