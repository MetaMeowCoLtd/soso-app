import { useState } from "react";
import { KeyboardAvoidingView, Platform, StyleSheet, TextInput, View } from "react-native";

import { ERROR_MESSAGES_EN, type NewPost, type PostAudience, type PostDetail, type SosoGateway } from "../core";
import { COLORS } from "../theme/tokens";
import { AppText } from "../ui/AppText";
import { Button } from "../ui/Button";

/**
 * Ported from apps/web/src/web/ThoughtComposer.tsx — the location-optional
 * feed's own composer ("thought", migration 0030). No place chrome
 * anywhere in here, on purpose: this category's whole point is having none.
 *
 * The web version's attach control is not ported — see that file's own
 * candid note: `post_media` has no upload path for this composer on web
 * either, so there's nothing working to port in the first place. C10 is
 * where a real attach control would go, for both platforms at once.
 */
interface ThoughtComposerProps {
  gateway: SosoGateway;
  onCancel: () => void;
  onPosted: (post: PostDetail) => void;
}

const BODY_MAX_LENGTH = 500;

const AUDIENCE_OPTIONS: { key: PostAudience; label: string }[] = [
  { key: "public", label: "Everyone" },
  { key: "friends", label: "Friends" },
  { key: "close_friends", label: "Close friends" },
];

export default function ThoughtComposer({ gateway, onCancel, onPosted }: ThoughtComposerProps) {
  const [body, setBody] = useState("");
  const [audience, setAudience] = useState<PostAudience>("public");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = body.trim();
  const canSubmit = trimmed.length > 0 && trimmed.length <= BODY_MAX_LENGTH && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const input: NewPost = { category: "thought", body: trimmed, audience, media: null };
      const pin = await gateway.createPost(input);
      // createPost's own return is a lightweight Pin, not the full
      // PostDetail a feed card needs — postDetail is what already builds
      // that shape elsewhere, reused here rather than re-derived by hand.
      const detail = await gateway.postDetail(pin.id);
      if (detail) {
        onPosted(detail);
      } else {
        onCancel();
      }
    } catch (err) {
      const code = (err as { code?: string }).code as keyof typeof ERROR_MESSAGES_EN | undefined;
      setError(code && code in ERROR_MESSAGES_EN ? ERROR_MESSAGES_EN[code] : ERROR_MESSAGES_EN["soso/unknown"]);
    } finally {
      setBusy(false);
    }
  }

  return (
    // `behavior="padding"` grows this view's own bottom padding by exactly
    // the keyboard's height, which is all that's needed here since the
    // sheet below is already anchored to the bottom via `justifyContent:
    // "flex-end"` — no manual offset, no measuring anything by hand.
    <KeyboardAvoidingView style={styles.backdrop} behavior={Platform.OS === "ios" ? "padding" : "height"}>
      <View style={styles.sheet}>
        <View style={styles.head}>
          <Button label="Cancel" variant="secondary" onPress={onCancel} disabled={busy} style={styles.headButton} />
          <AppText style={styles.headTitle}>New post</AppText>
          <Button label={busy ? "Posting…" : "Post"} onPress={() => void submit()} disabled={!canSubmit} style={styles.headButton} />
        </View>

        <TextInput
          style={styles.body}
          value={body}
          onChangeText={setBody}
          placeholder="What's on your mind?"
          placeholderTextColor={COLORS.muted}
          maxLength={BODY_MAX_LENGTH}
          multiline
          autoFocus
        />
        <AppText style={styles.count}>{trimmed.length}/{BODY_MAX_LENGTH}</AppText>

        <View style={styles.audiencePicker}>
          <AppText style={styles.audienceLabel}>Visible to</AppText>
          <View style={styles.audienceOptions}>
            {AUDIENCE_OPTIONS.map((option) => (
              <Button
                key={option.key}
                label={option.label}
                variant={audience === option.key ? "primary" : "secondary"}
                onPress={() => setAudience(option.key)}
                style={styles.audienceButton}
              />
            ))}
          </View>
        </View>

        {error && <AppText style={styles.error}>{error}</AppText>}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  sheet: { backgroundColor: COLORS.glass, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 16 },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 12 },
  headButton: { paddingHorizontal: 14, paddingVertical: 8 },
  headTitle: { fontWeight: "700", fontSize: 15 },
  body: { fontSize: 16, minHeight: 120, textAlignVertical: "top", color: COLORS.ink },
  count: { fontSize: 12, color: COLORS.muted, textAlign: "right", marginBottom: 12 },
  audiencePicker: { marginBottom: 12 },
  audienceLabel: { fontSize: 12, fontWeight: "600", marginBottom: 6 },
  audienceOptions: { flexDirection: "row", gap: 8 },
  audienceButton: { paddingHorizontal: 12, paddingVertical: 6 },
  error: { fontSize: 12, color: COLORS.hot },
});
