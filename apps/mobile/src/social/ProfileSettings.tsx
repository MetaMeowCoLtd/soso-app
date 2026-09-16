import { useEffect, useMemo, useState } from "react";
import { Image, Pressable, ScrollView, StyleSheet, Switch, TextInput, View } from "react-native";

import { bioRemaining, BIO_MAX, DISPLAY_NAME_MAX, ERROR_MESSAGES_EN, validateBio, validateDisplayName, type MyProfile, type SosoGateway } from "../core";
import AvatarCropper from "../media/AvatarCropper";
import CoverCropper from "../media/CoverCropper";
import { useAvatarPhoto } from "../media/useAvatarPhoto";
import { useCoverPhoto } from "../media/useCoverPhoto";
import { Icon, ICONS } from "../theme/Icon";
import { COLORS } from "../theme/tokens";
import { AppText } from "../ui/AppText";
import { Avatar } from "../ui/Avatar";
import { Button } from "../ui/Button";

/**
 * Ported from apps/web/src/web/ProfileSettings.tsx — name, bio, the
 * presence toggle, and, as of C10, the avatar/cover pickers themselves
 * (`useAvatarPhoto`/`useCoverPhoto`, `AvatarCropper`/`CoverCropper`).
 *
 * STILL NOT HERE: the push-notification toggle — native push is C12's
 * job, and showing a toggle that can't actually subscribe to anything yet
 * would be worse than not showing one.
 *
 * NOTHING IS STORED UNTIL SAVE, same as web: name/bio edits, and a picked
 * photo, are local state until `updateProfile` runs — a photo is uploaded
 * the moment its crop is confirmed (uploading is the slow part; no reason
 * to make Save wait on it too), but the PROFILE ROW doesn't change until
 * this screen's own Save button does the rest.
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
  const [coverPath, setCoverPath] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ name: string; bio: string; avatarPath: string | null; coverPath: string | null } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const avatarPhoto = useAvatarPhoto(gateway);
  const coverPhoto = useCoverPhoto(gateway);

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
        setCoverPath(profile.coverPath);
        setSaved({ name: profile.displayName, bio: profile.bio, avatarPath: profile.avatarPath, coverPath: profile.coverPath });
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

  // Uploaded the moment a crop is confirmed — the slow part is the upload,
  // not this screen's own Save, so there's no reason to make Save wait on
  // it too. The PROFILE ROW only changes once Save actually runs; until
  // then this is exactly like editing the name field, just for a photo.
  useEffect(() => {
    if (!avatarPhoto.pendingUri) return;
    void avatarPhoto.upload().then((path) => {
      if (path) setAvatarPath(path);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [avatarPhoto.pendingUri]);

  useEffect(() => {
    if (!coverPhoto.pendingUri) return;
    void coverPhoto.upload().then((path) => {
      if (path) setCoverPath(path);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coverPhoto.pendingUri]);

  const nameCheck = useMemo(() => validateDisplayName(name), [name]);
  const bioCheck = useMemo(() => validateBio(bio), [bio]);
  const remaining = bioRemaining(bio);

  const dirty =
    saved !== null &&
    (name.trim() !== saved.name.trim() || bio.trim() !== saved.bio.trim() || avatarPath !== saved.avatarPath || coverPath !== saved.coverPath);
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
        coverPath,
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
          <Pressable onPress={coverPhoto.pick} disabled={coverPhoto.rendering} accessibilityLabel="Change your cover photo">
            {coverPath ? (
              <Image source={{ uri: gateway.avatarUrl(coverPath) ?? undefined }} style={styles.coverBlock} />
            ) : (
              <View style={[styles.coverBlock, styles.coverEmpty]}>
                <Icon src={ICONS.image} size={20} color={COLORS.muted} />
              </View>
            )}
          </Pressable>

          <View style={styles.avatarBlock}>
            <Pressable onPress={avatarPhoto.pick} disabled={avatarPhoto.rendering} accessibilityLabel="Change your profile photo">
              <Avatar name={name || "You"} seed={handle ?? "you"} src={avatarPath ? gateway.avatarUrl(avatarPath) : null} size={92} />
              <View style={styles.photoBadge}>
                <Icon src={ICONS.image} size={12} color="#ffffff" />
              </View>
            </Pressable>
          </View>
          {(avatarPhoto.error || coverPhoto.error) && <AppText style={styles.error}>{avatarPhoto.error ?? coverPhoto.error}</AppText>}

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

      {avatarPhoto.cropping && (
        <AvatarCropper image={avatarPhoto.cropping} busy={avatarPhoto.rendering} onConfirm={avatarPhoto.applyCrop} onCancel={avatarPhoto.closeCropper} />
      )}
      {coverPhoto.cropping && (
        <CoverCropper image={coverPhoto.cropping} busy={coverPhoto.rendering} onConfirm={coverPhoto.applyCrop} onCancel={coverPhoto.closeCropper} />
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
  coverBlock: { width: "100%", height: 120, borderRadius: 12, marginBottom: -46 },
  coverEmpty: { backgroundColor: "rgba(20,50,43,0.06)", alignItems: "center", justifyContent: "center" },
  avatarBlock: { alignItems: "center", marginBottom: 24 },
  photoBadge: {
    position: "absolute",
    right: -2,
    bottom: -2,
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: COLORS.teal,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: COLORS.screenBackground,
  },
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
