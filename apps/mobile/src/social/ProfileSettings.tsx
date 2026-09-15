import { useEffect, useMemo, useState } from "react";
import { ScrollView, StyleSheet, Switch, TextInput, View } from "react-native";

import { bioRemaining, BIO_MAX, DISPLAY_NAME_MAX, ERROR_MESSAGES_EN, validateBio, validateDisplayName, type MyProfile, type SosoGateway } from "../core";
import { COLORS } from "../theme/tokens";
import { AppText } from "../ui/AppText";
import { Avatar } from "../ui/Avatar";
import { Button } from "../ui/Button";

/**
 * Ported from apps/web/src/web/ProfileSettings.tsx — name, bio, and the
 * presence toggle. Two things the web version does are deliberately NOT
 * here yet:
 *
 *   - Changing your avatar/cover photo (`AvatarCropper`/`CoverCropper`,
 *     `decodeAvatarFile`/`renderAvatarCrop`) — the whole image pipeline is
 *     C10's job. The tile below shows the CURRENT photo read-only; there's
 *     no picker, so nothing here can leave an uploaded-but-unsaved photo
 *     behind the way the web version is careful to avoid.
 *   - The push-notification toggle — native push is C12's job, and showing
 *     a toggle that can't actually subscribe to anything yet would be
 *     worse than not showing one.
 *
 * NOTHING IS STORED UNTIL SAVE, same as web: name/bio edits are local
 * state until `updateProfile` runs.
 */
interface ProfileSettingsProps {
  gateway: SosoGateway;
  demoMode: boolean;
  presenceSharing: boolean;
  onTogglePresence: (enabled: boolean) => void;
  onClose: () => void;
  onSaved: (profile: MyProfile) => void;
}

export default function ProfileSettings({ gateway, demoMode, presenceSharing, onTogglePresence, onClose, onSaved }: ProfileSettingsProps) {
  const [loaded, setLoaded] = useState(false);
  const [handle, setHandle] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [bio, setBio] = useState("");
  const [avatarPath, setAvatarPath] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ name: string; bio: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const profile = await gateway.myProfile();
        if (!alive || !profile) {
          if (alive) setLoaded(true);
          return;
        }
        setHandle(profile.handle);
        setName(profile.displayName);
        setBio(profile.bio);
        setAvatarPath(profile.avatarPath);
        setSaved({ name: profile.displayName, bio: profile.bio });
      } catch {
        if (alive) setError(ERROR_MESSAGES_EN["soso/unknown"]);
      } finally {
        if (alive) setLoaded(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [gateway]);

  const nameCheck = useMemo(() => validateDisplayName(name), [name]);
  const bioCheck = useMemo(() => validateBio(bio), [bio]);
  const remaining = bioRemaining(bio);

  const dirty = saved !== null && (name.trim() !== saved.name.trim() || bio.trim() !== saved.bio.trim());
  const canSave = loaded && dirty && nameCheck.ok && bioCheck.ok && !saving;

  async function save() {
    if (!canSave || !nameCheck.ok || !bioCheck.ok) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await gateway.updateProfile({
        displayName: nameCheck.value,
        bio: bioCheck.value,
        avatarPath,
        coverPath: null,
      });
      onSaved(updated);
      onClose();
    } catch (err) {
      const code = (err as { code?: string; message?: string }).code ?? (err as { message?: string }).message ?? "";
      setError(code in ERROR_MESSAGES_EN ? ERROR_MESSAGES_EN[code as keyof typeof ERROR_MESSAGES_EN] : ERROR_MESSAGES_EN["soso/unknown"]);
    } finally {
      setSaving(false);
    }
  }

  const nameProblem = name.length > 0 && !nameCheck.ok ? (nameCheck.problem === "empty" ? "Enter a name." : `At most ${DISPLAY_NAME_MAX} characters.`) : null;

  return (
    <View style={styles.flex1}>
      <View style={styles.header}>
        <Button label="Cancel" variant="secondary" onPress={onClose} style={styles.headerButton} />
        <AppText style={styles.headerTitle}>Edit profile</AppText>
        <Button label={saving ? "Saving…" : "Save"} onPress={() => void save()} disabled={!canSave} style={styles.headerButton} />
      </View>

      {!loaded ? (
        <AppText style={styles.loading}>Loading…</AppText>
      ) : (
        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
          <View style={styles.avatarBlock}>
            <Avatar name={name || "You"} seed={handle ?? "you"} src={avatarPath ? gateway.avatarUrl(avatarPath) : null} size={92} />
          </View>

          <View style={styles.field}>
            <AppText style={styles.label}>Display name</AppText>
            <TextInput
              style={styles.input}
              value={name}
              onChangeText={setName}
              maxLength={DISPLAY_NAME_MAX + 10}
              placeholder="Your name"
              placeholderTextColor={COLORS.muted}
            />
            <AppText style={[styles.sub, nameProblem && styles.subBad]}>{nameProblem ?? "The name people see next to your posts."}</AppText>
          </View>

          <View style={styles.field}>
            <AppText style={styles.label}>Bio</AppText>
            <TextInput
              style={[styles.input, styles.textArea]}
              value={bio}
              onChangeText={setBio}
              multiline
              numberOfLines={3}
              placeholder="Say a little about yourself"
              placeholderTextColor={COLORS.muted}
            />
            <AppText style={[styles.sub, remaining < 0 && styles.subBad]}>{remaining} / {BIO_MAX}</AppText>
          </View>

          {handle && (
            <View style={styles.field}>
              <AppText style={styles.label}>Username</AppText>
              <AppText style={styles.readonlyValue}>@{handle}</AppText>
              <AppText style={styles.sub}>Chosen at sign-up and can't be changed here.</AppText>
            </View>
          )}

          <View style={styles.toggleRow}>
            <View style={styles.toggleText}>
              <AppText style={styles.toggleTitle}>Share your presence</AppText>
              <AppText style={styles.sub}>
                {demoMode
                  ? "Presence needs the live backend — demo mode has nobody to share it with."
                  : "Friends who follow you back can see you're online, and whether you're in the same ward — never where."}
              </AppText>
            </View>
            <Switch value={presenceSharing} onValueChange={onTogglePresence} disabled={demoMode} />
          </View>

          {error && <AppText style={styles.error}>{error}</AppText>}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  flex1: { flex: 1, backgroundColor: COLORS.screenBackground },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 16 },
  headerButton: { paddingHorizontal: 12, paddingVertical: 6 },
  headerTitle: { fontWeight: "700", fontSize: 15 },
  loading: { textAlign: "center", marginTop: 40, color: COLORS.muted },
  scroll: { flex: 1 },
  scrollContent: { padding: 16 },
  avatarBlock: { alignItems: "center", marginBottom: 24 },
  field: { marginBottom: 20 },
  label: { fontSize: 13, fontWeight: "600", marginBottom: 6 },
  input: { borderWidth: 1, borderColor: COLORS.line, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 12, fontSize: 15, color: COLORS.ink },
  textArea: { minHeight: 70, textAlignVertical: "top" },
  sub: { fontSize: 11, color: COLORS.muted, marginTop: 4 },
  subBad: { color: COLORS.hot },
  readonlyValue: { fontSize: 15 },
  toggleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 20 },
  toggleText: { flex: 1 },
  toggleTitle: { fontWeight: "700", fontSize: 14, marginBottom: 4 },
  error: { color: COLORS.hot, fontSize: 13 },
});
