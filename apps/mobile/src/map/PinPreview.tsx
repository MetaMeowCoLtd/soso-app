import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import {
  ERROR_MESSAGES_EN,
  formatAgo,
  formatCountdown,
  type CategoryConfig,
  type Pin,
  type PostDetail,
  type ReportReason,
  type SosoGateway,
} from "../core";
import PostMediaView from "../media/PostMediaView";
import { lookOf } from "../theme/categories";
import { Icon, ICONS } from "../theme/Icon";
import { COLORS } from "../theme/tokens";
import { AppText } from "../ui/AppText";
import { Button } from "../ui/Button";

/**
 * Ported from apps/web/src/web/PinPreview.tsx. Validity voting is the ONLY
 * signal here, same as web — a strong enough run of downvotes drains a
 * pin's colour and then fades it (`PinMarker.tsx`'s `pinOpacity`/
 * `pinSaturation`) and, past a threshold, expires the post outright, the
 * same way the author's own "Remove this now" already does.
 *
 * `mine` decides which actions render; the server enforces the actual rule
 * (`vote_post` rejects self-votes) independent of what this shows — this
 * never pre-checks anything the server doesn't already gate.
 *
 * The attached-media section, deferred through C9, renders via
 * `PostMediaView` as of C10 — same component FeedCard uses, for the same
 * reason web shares one between its own feed and this preview.
 */

interface PinPreviewProps {
  gateway: SosoGateway;
  pin: Pin;
  detail: PostDetail | null;
  categories: CategoryConfig[];
  nowSeconds: number;
  onClose: () => void;
  onVote: (postId: string, vote: 1 | -1) => Promise<void>;
  onReport: (postId: string, reason: ReportReason) => Promise<void>;
  onResolve: (postId: string) => Promise<void>;
  onShare: (postId: string) => void;
  onOpenThread: (postId: string) => void;
}

const REPORT_REASONS: { label: string; value: ReportReason }[] = [
  { label: "Not true", value: "false_information" },
  { label: "Harassment", value: "harassment" },
  { label: "Privacy", value: "privacy" },
  { label: "Spam", value: "spam" },
];

export default function PinPreview({
  gateway,
  pin,
  detail,
  categories,
  nowSeconds,
  onClose,
  onVote,
  onReport,
  onResolve,
  onShare,
  onOpenThread,
}: PinPreviewProps) {
  const [voting, setVoting] = useState(false);
  const [voted, setVoted] = useState<1 | -1 | null>(null);
  const [voteNotice, setVoteNotice] = useState<string | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  const [reported, setReported] = useState(false);
  const [removeConfirmOpen, setRemoveConfirmOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [removed, setRemoved] = useState(false);

  const category = categories.find((c) => c.key === pin.category);
  const subtype = category?.subtypes.find((s) => s.key === pin.subtype);
  const look = lookOf(pin.category);

  async function vote(value: 1 | -1) {
    setVoting(true);
    setVoteNotice(null);
    try {
      await onVote(pin.id, value);
      setVoted(value);
    } catch (err) {
      const code = (err as { code?: string }).code;
      setVoteNotice(code === "soso/cannot_vote_own" ? "That's your own post." : "Couldn't send that — try again.");
    } finally {
      setVoting(false);
    }
  }

  async function report(reason: ReportReason) {
    setReportOpen(false);
    setReportError(null);
    try {
      await onReport(pin.id, reason);
      setReported(true);
    } catch (err) {
      const code = (err as { code?: string }).code as keyof typeof ERROR_MESSAGES_EN | undefined;
      setReportError(code && code in ERROR_MESSAGES_EN ? ERROR_MESSAGES_EN[code] : ERROR_MESSAGES_EN["soso/unknown"]);
    }
  }

  async function confirmRemove() {
    setRemoving(true);
    setRemoveError(null);
    try {
      await onResolve(pin.id);
      setRemoved(true);
    } catch {
      setRemoveError("Couldn't remove that — try again.");
    } finally {
      setRemoving(false);
    }
  }

  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <View style={styles.flex1}>
          <View style={styles.kickerRow}>
            <Icon src={look.icon} size={15} color={look.color} />
            <AppText style={[styles.kicker, { color: look.color }]}>
              {subtype?.labelEn ?? category?.labelEn ?? pin.category}
            </AppText>
          </View>
          <AppText style={styles.age}>{formatAgo(pin.createdAt, nowSeconds)}</AppText>
        </View>
        <Pressable onPress={onClose} style={styles.closeButton} accessibilityLabel="Close preview">
          <Icon src={ICONS.close} size={15} color={COLORS.muted} />
        </Pressable>
      </View>

      {detail?.address && (
        <View style={styles.addressRow}>
          <Icon src={ICONS.place} size={13} color={COLORS.muted} />
          <AppText style={styles.address}>{detail.address}</AppText>
        </View>
      )}

      {detail?.body && <AppText style={styles.snippet}>{detail.body}</AppText>}

      {detail?.media[0] && (
        <View style={styles.mediaWrap}>
          <PostMediaView gateway={gateway} media={detail.media[0]} maxHeight={220} />
        </View>
      )}

      <View style={styles.metaRow}>
        <AppText style={styles.countdown}>Disappears in {formatCountdown(pin.expiresAt, nowSeconds)}</AppText>

        <View style={styles.metaActions}>
          <Button label="Thread" variant="secondary" onPress={() => onOpenThread(pin.id)} style={styles.smallButton} />
          <Button label="Share" variant="secondary" onPress={() => onShare(pin.id)} style={styles.smallButton} />
        </View>
      </View>

      <View style={styles.voteRow}>
        <Button
          label={`👍 ${detail?.confirmCount ?? 0}`}
          variant={voted === 1 ? "primary" : "secondary"}
          disabled={voting || voted !== null || Boolean(detail?.mine)}
          onPress={() => void vote(1)}
          style={styles.voteButton}
        />
        <Button
          label={`👎 ${detail?.disputeCount ?? 0}`}
          variant={voted === -1 ? "primary" : "secondary"}
          disabled={voting || voted !== null || Boolean(detail?.mine)}
          onPress={() => void vote(-1)}
          style={styles.voteButton}
        />
      </View>
      {voteNotice && <AppText style={styles.notice}>{voteNotice}</AppText>}

      {detail?.mine ? (
        <View style={styles.ownSection}>
          <AppText style={styles.ownText}>You posted this.</AppText>
          {removed ? (
            <AppText style={styles.ownText}>Removed — thanks for keeping the map current.</AppText>
          ) : removeConfirmOpen ? (
            <View>
              <AppText style={styles.notice}>
                This removes your post immediately, before its normal expiry. This can't be undone.
              </AppText>
              <View style={styles.confirmRow}>
                <Button label="Cancel" variant="secondary" onPress={() => setRemoveConfirmOpen(false)} disabled={removing} />
                <Button label={removing ? "Removing…" : "Yes, remove it"} onPress={() => void confirmRemove()} disabled={removing} />
              </View>
              {removeError && <AppText style={styles.notice}>{removeError}</AppText>}
            </View>
          ) : (
            <Button label="Remove this now" variant="secondary" onPress={() => setRemoveConfirmOpen(true)} />
          )}
        </View>
      ) : (
        <View style={styles.reportSection}>
          {reported ? (
            <AppText style={styles.ownText}>Reported — thanks, we'll look at it.</AppText>
          ) : reportOpen ? (
            <View style={styles.reportReasons}>
              {REPORT_REASONS.map((r) => (
                <Button key={r.value} label={r.label} variant="secondary" onPress={() => void report(r.value)} style={styles.smallButton} />
              ))}
            </View>
          ) : (
            <Button label="Report this post" variant="secondary" onPress={() => setReportOpen(true)} style={styles.smallButton} />
          )}
          {reportError && <AppText style={styles.notice}>{reportError}</AppText>}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: COLORS.glass,
    borderRadius: 16,
    padding: 16,
  },
  flex1: { flex: 1 },
  head: { flexDirection: "row", alignItems: "flex-start", marginBottom: 8 },
  kickerRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  kicker: { fontSize: 13, fontWeight: "700", textTransform: "capitalize" },
  age: { fontSize: 12, color: COLORS.muted, marginTop: 2 },
  closeButton: { paddingHorizontal: 12, paddingVertical: 6 },
  addressRow: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 6 },
  address: { fontSize: 12, color: COLORS.muted },
  snippet: { fontSize: 14, marginBottom: 10 },
  mediaWrap: { marginBottom: 10 },
  metaRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 10 },
  countdown: { fontSize: 12, color: COLORS.muted },
  metaActions: { flexDirection: "row", gap: 8 },
  smallButton: { paddingHorizontal: 12, paddingVertical: 6 },
  voteRow: { flexDirection: "row", gap: 8, marginBottom: 8 },
  voteButton: { flex: 1 },
  notice: { fontSize: 12, color: COLORS.hot, marginBottom: 8 },
  ownSection: { marginTop: 4, gap: 8 },
  ownText: { fontSize: 13, color: COLORS.muted },
  confirmRow: { flexDirection: "row", gap: 8, marginTop: 8 },
  reportSection: { marginTop: 4 },
  reportReasons: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
});
