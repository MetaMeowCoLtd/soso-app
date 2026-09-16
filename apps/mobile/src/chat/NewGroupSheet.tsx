import { useMemo, useState } from "react";
import { Image, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";

import { ERROR_MESSAGES_EN, GROUP_MAX_MEMBERS, GROUP_MIN_OTHERS, GROUP_TITLE_MAX, groupTitleFromMembers, type DmThread, type DmThreadMember, type Friend, type SosoGateway } from "../core";
import AvatarCropper from "../media/AvatarCropper";
import { useAvatarPhoto } from "../media/useAvatarPhoto";
import { Icon, ICONS } from "../theme/Icon";
import { COLORS } from "../theme/tokens";
import { AppText } from "../ui/AppText";
import { Avatar } from "../ui/Avatar";

/**
 * Ported from apps/web/src/web/NewGroupSheet.tsx: pick people, then
 * (optionally) name it, same two steps, same "selecting exactly one person
 * opens the DM instead" precedence. The photo step, deferred through C9,
 * is wired here now via `useAvatarPhoto` — same square pipeline
 * GroupDetailsSheet uses to change one after creation.
 */
interface NewGroupSheetProps {
  gateway: SosoGateway;
  friends: Friend[];
  onCreated: (thread: DmThread) => void;
  onOpenDirect: (userId: string) => void;
  onClose: () => void;
}

export default function NewGroupSheet({ gateway, friends, onCreated, onOpenDirect, onClose }: NewGroupSheetProps) {
  const [step, setStep] = useState<"who" | "about">("who");
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const photo = useAvatarPhoto(gateway);

  const byId = useMemo(() => new Map(friends.map((f) => [f.id, f])), [friends]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = q ? friends.filter((f) => f.displayName.toLowerCase().includes(q) || f.handle.toLowerCase().includes(q)) : friends;
    return [...rows].sort((a, b) => {
      if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1;
      return a.displayName.localeCompare(b.displayName);
    });
  }, [friends, query]);

  const chosen = useMemo(() => selected.map((id) => byId.get(id)).filter((f): f is Friend => Boolean(f)), [selected, byId]);

  const generatedTitle = useMemo(
    () =>
      groupTitleFromMembers(
        chosen.map((f): DmThreadMember => ({ id: f.id, handle: f.handle, displayName: f.displayName, avatarPath: f.avatarPath, role: "member", blocked: false })),
        chosen.length,
      ),
    [chosen],
  );

  const full = selected.length >= GROUP_MAX_MEMBERS - 1;

  function toggle(id: string) {
    setError(null);
    setSelected((current) => {
      if (current.includes(id)) return current.filter((x) => x !== id);
      if (current.length >= GROUP_MAX_MEMBERS - 1) return current;
      return [...current, id];
    });
  }

  function advance() {
    if (selected.length === 1) {
      onOpenDirect(selected[0]!);
      onClose();
      return;
    }
    if (selected.length < GROUP_MIN_OTHERS) return;
    setError(null);
    setStep("about");
  }

  async function create() {
    if (creating || selected.length < GROUP_MIN_OTHERS) return;
    setCreating(true);
    setError(null);
    try {
      // The photo goes up first — same order and reasoning as web's own
      // `create()`: if the thread creation then fails, the orphaned object
      // costs nothing and a retry doesn't compound it.
      const photoPath = await photo.upload();
      const thread = await gateway.createGroupThread({ title: title.trim() || null, memberIds: selected, photoPath });
      onCreated(thread);
    } catch (err) {
      const code = (err as { code?: string }).code as keyof typeof ERROR_MESSAGES_EN | undefined;
      setError(code && code in ERROR_MESSAGES_EN ? ERROR_MESSAGES_EN[code] : ERROR_MESSAGES_EN["soso/unknown"]);
      setCreating(false);
    }
  }

  return (
    <View style={styles.sheet}>
      <View style={styles.head}>
        <Pressable onPress={() => (step === "about" ? setStep("who") : onClose())} accessibilityLabel={step === "about" ? "Back to choosing people" : "Close"}>
          <Icon src={step === "about" ? ICONS.chevronLeft : ICONS.close} size={step === "about" ? 17 : 13} color={COLORS.ink} />
        </Pressable>
        <AppText style={styles.headTitle}>{step === "who" ? "New group" : "Name this group"}</AppText>
        {step === "who" ? (
          <Pressable onPress={advance} disabled={selected.length === 0}>
            <AppText style={[styles.headAction, selected.length === 0 && styles.headActionDisabled]}>{selected.length === 1 ? "Message" : "Next"}</AppText>
          </Pressable>
        ) : (
          <Pressable onPress={() => void create()} disabled={creating}>
            <AppText style={styles.headAction}>{creating ? "Creating…" : "Create"}</AppText>
          </Pressable>
        )}
      </View>

      {step === "who" ? (
        <>
          <View style={styles.search}>
            <Icon src={ICONS.search} size={15} color={COLORS.muted} />
            <TextInput style={styles.searchInput} value={query} onChangeText={setQuery} placeholder="Search friends" autoFocus />
          </View>

          {chosen.length > 0 && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow} contentContainerStyle={styles.chipRowContent}>
              {chosen.map((friend) => (
                <Pressable key={friend.id} style={styles.chip} onPress={() => toggle(friend.id)}>
                  <Avatar name={friend.displayName} seed={friend.handle} src={gateway.avatarUrl(friend.avatarPath)} size={20} />
                  <AppText style={styles.chipText}>{friend.displayName}</AppText>
                  <Icon src={ICONS.close} size={9} color={COLORS.muted} />
                </Pressable>
              ))}
            </ScrollView>
          )}

          {full && <AppText style={styles.note}>That's {GROUP_MAX_MEMBERS} people including you — the most a group can hold.</AppText>}
          {error && <AppText style={styles.error}>{error}</AppText>}

          <ScrollView>
            {friends.length === 0 ? (
              <View style={styles.blank}>
                <Icon src={ICONS.people} size={26} color={COLORS.muted} />
                <AppText style={styles.blankTitle}>No friends yet</AppText>
                <AppText style={styles.blankText}>A group is made from people you follow each other with. Follow someone from People and have them follow you back.</AppText>
              </View>
            ) : matches.length === 0 ? (
              <AppText style={styles.emptyText}>Nobody matches "{query.trim()}".</AppText>
            ) : (
              matches.map((friend) => {
                const on = selected.includes(friend.id);
                return (
                  <Pressable key={friend.id} style={styles.pickerRow} disabled={full && !on} onPress={() => toggle(friend.id)}>
                    <Avatar name={friend.displayName} seed={friend.handle} src={gateway.avatarUrl(friend.avatarPath)} size={42} online={friend.isOnline} />
                    <View style={styles.pickerWho}>
                      <AppText style={styles.pickerName}>{friend.displayName}</AppText>
                      <AppText style={styles.pickerHandle}>@{friend.handle}</AppText>
                    </View>
                    <View style={[styles.check, on && styles.checkOn]}>{on && <Icon src={ICONS.check} size={12} color="#ffffff" />}</View>
                  </Pressable>
                );
              })
            )}
          </ScrollView>
        </>
      ) : (
        <ScrollView contentContainerStyle={styles.about}>
          <Pressable style={styles.photoPick} onPress={photo.pick} disabled={photo.rendering} accessibilityLabel={photo.pendingUri ? "Change the group photo" : "Add a group photo"}>
            {photo.pendingUri ? (
              <Image source={{ uri: photo.pendingUri }} style={styles.photoPickImage} />
            ) : (
              <Icon src={ICONS.image} size={22} color={COLORS.muted} />
            )}
            <View style={styles.photoBadge}>
              <Icon src={ICONS.plus} size={11} color="#ffffff" />
            </View>
          </Pressable>
          <AppText style={styles.photoHint}>
            {photo.rendering ? "Opening that photo…" : photo.pendingUri ? "Tap to pick a different one" : "Add a photo — optional"}
          </AppText>
          {photo.error && <AppText style={styles.error}>{photo.error}</AppText>}

          <TextInput
            style={styles.nameField}
            value={title}
            onChangeText={setTitle}
            maxLength={GROUP_TITLE_MAX}
            placeholder={generatedTitle}
            accessibilityLabel="Group name"
            autoFocus
          />
          <AppText style={styles.nameHint}>
            Leave it empty and the group is called {generatedTitle}. Anyone in the group can rename it later.
          </AppText>

          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow} contentContainerStyle={styles.chipRowContent}>
            {chosen.map((friend) => (
              <View key={friend.id} style={styles.chip}>
                <Avatar name={friend.displayName} seed={friend.handle} src={gateway.avatarUrl(friend.avatarPath)} size={20} />
                <AppText style={styles.chipText}>{friend.displayName}</AppText>
              </View>
            ))}
          </ScrollView>

          {error && <AppText style={styles.error}>{error}</AppText>}
        </ScrollView>
      )}

      {photo.cropping && <AvatarCropper image={photo.cropping} busy={photo.rendering} onConfirm={photo.applyCrop} onCancel={photo.closeCropper} />}
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: COLORS.screenBackground },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 16 },
  headTitle: { fontSize: 16, fontWeight: "700" },
  headAction: { color: COLORS.teal, fontWeight: "700" },
  headActionDisabled: { opacity: 0.4 },
  search: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "#ffffff", borderRadius: 10, marginHorizontal: 16, paddingHorizontal: 10, marginBottom: 8 },
  searchInput: { flex: 1, paddingVertical: 8, fontSize: 14 },
  chipRow: { maxHeight: 44, marginBottom: 8 },
  chipRowContent: { paddingHorizontal: 16, gap: 8 },
  chip: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: COLORS.glass, borderRadius: 16, paddingHorizontal: 8, paddingVertical: 4 },
  chipText: { fontSize: 12, fontWeight: "600" },
  note: { fontSize: 12, color: COLORS.muted, paddingHorizontal: 16, marginBottom: 8 },
  error: { color: COLORS.hot, fontSize: 12, paddingHorizontal: 16, marginBottom: 8 },
  emptyText: { color: COLORS.muted, textAlign: "center", padding: 24 },
  blank: { alignItems: "center", padding: 32, gap: 8 },
  blankTitle: { fontWeight: "700", fontSize: 15 },
  blankText: { color: COLORS.muted, fontSize: 12, textAlign: "center" },
  pickerRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingVertical: 10 },
  pickerWho: { flex: 1 },
  pickerName: { fontWeight: "700", fontSize: 14 },
  pickerHandle: { fontSize: 12, color: COLORS.muted },
  check: { width: 22, height: 22, borderRadius: 11, borderWidth: 1.5, borderColor: COLORS.line, alignItems: "center", justifyContent: "center" },
  checkOn: { backgroundColor: COLORS.teal, borderColor: COLORS.teal },
  about: { padding: 16, gap: 8, alignItems: "center" },
  photoPick: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: "rgba(20,50,43,0.06)",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  photoPickImage: { width: 88, height: 88 },
  photoBadge: {
    position: "absolute",
    right: 0,
    bottom: 0,
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: COLORS.teal,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: COLORS.screenBackground,
  },
  photoHint: { fontSize: 12, color: COLORS.muted },
  nameField: { borderWidth: 1, borderColor: COLORS.line, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  nameHint: { fontSize: 12, color: COLORS.muted },
});
