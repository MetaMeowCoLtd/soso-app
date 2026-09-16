import { useState } from "react";
import { ActivityIndicator, Image, Pressable, StyleSheet, View } from "react-native";
import { useVideoPlayer, VideoView } from "expo-video";

import type { PostMedia, SosoGateway } from "../core";
import { Icon, ICONS } from "../theme/Icon";
import { COLORS } from "../theme/tokens";
import { AppText } from "../ui/AppText";
import { useMessageImageUrl } from "./useMessageImageUrl";

/**
 * Ported from apps/web/src/web/PostMediaView.tsx — a post's attachment as
 * a full-width card, distinct from `MessageMediaView`'s bubble because the
 * two really do look different on web too (a full card vs. a bounded
 * bubble) — not a new distinction invented for this port. Shares
 * `useMessageImageUrl` with message attachments for the same reason the
 * web version gives: resolving a path to a URL is the same problem on
 * both surfaces, so post media gets the same request batching and
 * on-device cache that message media already has.
 */
export default function PostMediaView({ gateway, media, maxHeight = 320 }: { gateway: SosoGateway; media: PostMedia; maxHeight?: number }) {
  const thumbKey = media.kind === "video" ? media.posterKey! : media.objectKey;
  const [failed, setFailed] = useState(false);
  const [playing, setPlaying] = useState(false);

  const { url: thumbUrl, loading } = useMessageImageUrl(gateway, thumbKey);
  const { url: clipUrl } = useMessageImageUrl(gateway, playing && media.kind === "video" ? media.objectKey : null);
  const player = useVideoPlayer(playing ? clipUrl : null, (p) => {
    p.play();
  });

  const aspectRatio = media.width > 0 && media.height > 0 ? media.width / media.height : 4 / 3;
  const style = { aspectRatio, maxHeight, width: "100%" as const };

  if (loading) {
    return (
      <View style={[styles.box, style]}>
        <ActivityIndicator size="small" />
      </View>
    );
  }

  if (!thumbUrl || failed) {
    return (
      <View style={[styles.box, style]}>
        <AppText style={styles.missingText}>{media.kind === "video" ? "Video unavailable" : "Image unavailable"}</AppText>
      </View>
    );
  }

  if (media.kind === "video" && playing) {
    return (
      <View style={[styles.box, style]}>
        {clipUrl ? (
          <VideoView style={styles.fill} player={player} nativeControls contentFit="contain" />
        ) : (
          <Image source={{ uri: thumbUrl }} style={styles.fill} />
        )}
      </View>
    );
  }

  if (media.kind === "image") {
    return (
      <View style={[styles.box, style]}>
        <Image source={{ uri: thumbUrl }} style={styles.fill} onError={() => setFailed(true)} />
      </View>
    );
  }

  return (
    <Pressable style={[styles.box, style]} onPress={() => setPlaying(true)} accessibilityLabel="Play video">
      <Image source={{ uri: thumbUrl }} style={styles.fill} onError={() => setFailed(true)} />
      <View style={styles.playBadge}>
        <Icon src={ICONS.play} size={24} color="#ffffff" />
      </View>
      {media.durationMs !== null && (
        <View style={styles.durationBadge}>
          <AppText style={styles.durationText}>{formatClipLength(media.durationMs)}</AppText>
        </View>
      )}
    </Pressable>
  );
}

function formatClipLength(durationMs: number): string {
  const total = Math.max(0, Math.round(durationMs / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

const styles = StyleSheet.create({
  box: { borderRadius: 14, overflow: "hidden", backgroundColor: "rgba(0,0,0,0.06)", alignItems: "center", justifyContent: "center" },
  fill: { width: "100%", height: "100%" },
  missingText: { fontSize: 12, color: COLORS.muted },
  playBadge: { position: "absolute", width: 48, height: 48, borderRadius: 24, backgroundColor: "rgba(0,0,0,0.45)", alignItems: "center", justifyContent: "center" },
  durationBadge: { position: "absolute", right: 8, bottom: 8, backgroundColor: "rgba(0,0,0,0.6)", borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  durationText: { color: "#ffffff", fontSize: 12 },
});
