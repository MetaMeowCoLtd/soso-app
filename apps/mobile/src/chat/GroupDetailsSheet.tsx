import { useEffect, useMemo, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";

import {
  conversationTitle,
  ERROR_MESSAGES_EN,
  GROUP_MAX_MEMBERS,
  GROUP_TITLE_MAX,
  type DmThread,
  type DmThreadMember,
  type Friend,
  type SosoGateway,
} from "../core";
import AvatarCropper from "../media/AvatarCropper";
import { useAvatarPhoto } from "../media/useAvatarPhoto";
import { Icon, ICONS } from "../theme/Icon";
import { COLORS } from "../theme/tokens";
import { AppText } from "../ui/AppText";
import { Avatar } from "../ui/Avatar";
import { Button } from "../ui/Button";
import { Screen } from "../ui/Screen";
import { ConversationAvatar } from "./ConversationAvatar";

/**
 * Ported from apps/web/src/web/GroupDetailsSheet.tsx. Rename, add, remove
 * and leave all carry over unchanged. The photo change, deferred through
 * C9, is wired here now via `useAvatarPhoto` (a group's photo reuses the
 * avatar pipeline's square crop and storage — see cover.ts's own note on
 * why the avatar bucket is shared this way, and `useGroupPhoto.ts`'s
 * identical reuse on web).
 */
interface GroupDetailsSheetProps {
  thread: DmThread;
  gateway: SosoGateway;
  friends: Friend[];
  myId: string;
  myAvatarPath: string | null;
  onChanged: (thread: DmThread) => void;
  onLeft: () => void;
  onClose: () => void;
}

export default function GroupDetailsSheet({ thread, gateway, friends, myId, myAvatarPath, onChanged, onLeft, onClose }: GroupDetailsSheetProps) {
  const [members, setMembers] = useState<DmThreadMember[]>(thread.members);
  const [loaded, setLoaded] = useState(false);
  const [mode, setMode] = useState<"detail" | "add">("detail");
  const [renaming, setRenaming] = useState(false);
  const [draftTitle, setDraftTitle] = useState(thread.title ?? "");
  const [picked, setPicked] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const photo = useAvatarPhoto(gateway);

  const isOwner = thread.myRole === "owner";

  // Uploaded the instant a crop is confirmed, matching useGroupPhoto.ts's
  // own web behaviour — this screen has no separate Save step for anything
  // else on it, so a photo sitting pending until some other button was
  // found would be the one control here that silently didn't apply.
  useEffect(() => {
    if (!photo.pendingUri) return;
    void (async () => {
      setBusy(true);
      setError(null);
      try {
        const path = await photo.upload();
        if (path) {
          onChanged(await gateway.setGroupThreadPhoto(thread.id, path));
          photo.clear();
        }
      } catch (err) {
        report(err);
      } finally {
        setBusy(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photo.pendingUri]);

  useEffect(() => {
    let alive = true;
    void gateway
      .listDmThreadMembers(thread.id)
      .then((rows) => {
        if (alive) setMembers(rows);
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, [gateway, thread.id]);

  const addable = useMemo(() => {
    const inGroup = new Set([myId, ...members.map((m) => m.id)]);
    const q = query.trim().toLowerCase();
    return friends
      .filter((f) => !inGroup.has(f.id))
      .filter((f) => !q || f.displayName.toLowerCase().includes(q) || f.handle.toLowerCase().includes(q))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [friends, members, myId, query]);

  const room = GROUP_MAX_MEMBERS - (members.length + 1);

  function report(err: unknown) {
    const code = (err as { code?: string }).code as keyof typeof ERROR_MESSAGES_EN | undefined;
    setError(code && code in ERROR_MESSAGES_EN ? ERROR_MESSAGES_EN[code] : ERROR_MESSAGES_EN["soso/unknown"]);
  }

  async function run(action: () => Promise<DmThread>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      onChanged(await action());
      setMembers(await gateway.listDmThreadMembers(thread.id));
    } catch (err) {
      report(err);
    } finally {
      setBusy(false);
    }
  }

  async function saveTitle() {
    const next = draftTitle.trim();
    setRenaming(false);
    if (next === (thread.title ?? "")) return;
    await run(() => gateway.renameGroupThread(thread.id, next || null));
  }

  async function addPicked() {
    if (picked.length === 0) return;
    await run(() => gateway.addGroupMembers(thread.id, picked));
    setPicked([]);
    setQuery("");
    setMode("detail");
  }

  async function leave() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await gateway.leaveGroupThread(thread.id);
      onLeft();
    } catch (err) {
      report(err);
      setBusy(false);
    }
  }

  if (mode === "add") {
    return (
      <Modal visible animationType="slide" onRequestClose={() => setMode("detail")}>
        {/* A raw RN Modal, unlike a React Navigation screen, gets no safe-area
            treatment on its own — its header sat flush under the notch/status
            bar until this wrapped it in the same SafeAreaView every other
            full-screen surface in this app uses. */}
        <Screen edges={["top", "bottom"]}>
          <View style={styles.head}>
            <Pressable onPress={() => { setMode("detail"); setPicked([]); setQuery(""); }} accessibilityLabel="Back">
              <Icon src={ICONS.chevronLeft} size={17} color={COLORS.ink} />
            </Pressable>
            <AppText style={styles.headTitle}>Add people</AppText>
            <Pressable onPress={() => void addPicked()} disabled={picked.length === 0 || busy}>
              <AppText style={[styles.headAction, (picked.length === 0 || busy) && styles.headActionDisabled]}>
                {busy ? "Adding…" : picked.length > 0 ? `Add ${picked.length}` : "Add"}
              </AppText>
            </Pressable>
          </View>

          <View style={styles.search}>
            <Icon src={ICONS.search} size={15} color={COLORS.muted} />
            <TextInput style={styles.searchInput} value={query} onChangeText={setQuery} placeholder="Search friends" autoFocus />
          </View>

          <AppText style={styles.note}>You can only add people you follow each other with. Room for {room} more.</AppText>
          {error && <AppText style={styles.error}>{error}</AppText>}

          <ScrollView>
            {addable.length === 0 ? (
              <AppText style={styles.emptyText}>{query.trim() ? `Nobody matches "${query.trim()}".` : "Everyone you follow each other with is already here."}</AppText>
            ) : (
              addable.map((friend) => {
                const on = picked.includes(friend.id);
                return (
                  <Pressable
                    key={friend.id}
                    style={styles.pickerRow}
                    disabled={!on && picked.length >= room}
                    onPress={() => setPicked((current) => (current.includes(friend.id) ? current.filter((x) => x !== friend.id) : current.length >= room ? current : [...current, friend.id]))}
                  >
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
        </Screen>
      </Modal>
    );
  }

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <Screen edges={["top", "bottom"]}>
        <View style={styles.head}>
          <Pressable onPress={onClose} accessibilityLabel="Back">
            <Icon src={ICONS.chevronLeft} size={17} color={COLORS.ink} />
          </Pressable>
          <AppText style={styles.headTitle}>Group</AppText>
          <View style={{ width: 17 }} />
        </View>

        <ScrollView>
          <View style={styles.hero}>
            <Pressable onPress={photo.pick} disabled={busy || photo.rendering} accessibilityLabel="Change the group photo">
              <ConversationAvatar thread={thread} gateway={gateway} size={88} />
              <View style={styles.photoBadge}>
                <Icon src={ICONS.image} size={12} color="#ffffff" />
              </View>
            </Pressable>
            {photo.error && <AppText style={styles.error}>{photo.error}</AppText>}

            {renaming ? (
              <TextInput
                style={styles.renameInput}
                value={draftTitle}
                onChangeText={setDraftTitle}
                maxLength={GROUP_TITLE_MAX}
                placeholder={conversationTitle(thread)}
                autoFocus
                onBlur={() => void saveTitle()}
                onSubmitEditing={() => void saveTitle()}
              />
            ) : (
              <Pressable onPress={() => { setDraftTitle(thread.title ?? ""); setRenaming(true); }}>
                <AppText style={styles.heroName}>{conversationTitle(thread)}</AppText>
                <AppText style={styles.heroMeta}>
                  {thread.memberCount} {thread.memberCount === 1 ? "member" : "members"} · tap to rename
                </AppText>
              </Pressable>
            )}

            {error && <AppText style={styles.error}>{error}</AppText>}
          </View>

          <Pressable style={styles.action} onPress={() => setMode("add")} disabled={busy || room <= 0}>
            <Icon src={ICONS.personAdd} size={17} color={COLORS.ink} />
            <AppText style={styles.actionText}>{room > 0 ? "Add people" : `Full — ${GROUP_MAX_MEMBERS} people`}</AppText>
          </Pressable>

          <AppText style={styles.sectionTitle}>{loaded ? `${thread.memberCount} members` : "Members"}</AppText>

          <View style={styles.memberRow}>
            <Avatar name="You" seed={myId} src={gateway.avatarUrl(myAvatarPath)} size={40} />
            <View style={styles.pickerWho}>
              <AppText style={styles.pickerName}>You</AppText>
              <AppText style={styles.pickerHandle}>{isOwner ? "Created this group" : "Member"}</AppText>
            </View>
          </View>
          {members.map((member) => (
            <View key={member.id} style={styles.memberRow}>
              <Avatar name={member.displayName} seed={member.handle} src={gateway.avatarUrl(member.avatarPath)} size={40} />
              <View style={styles.pickerWho}>
                <AppText style={styles.pickerName}>{member.displayName}</AppText>
                <AppText style={styles.pickerHandle}>
                  {member.blocked ? "Blocked — you don't see their messages" : member.role === "owner" ? `Created this group · @${member.handle}` : `@${member.handle}`}
                </AppText>
              </View>
              {isOwner && (
                <Pressable onPress={() => void run(() => gateway.removeGroupMember(thread.id, member.id))} disabled={busy} accessibilityLabel={`Remove ${member.displayName}`}>
                  <Icon src={ICONS.personRemove} size={15} color={COLORS.hot} />
                </Pressable>
              )}
            </View>
          ))}

          <View style={styles.leaveSection}>
            {confirmLeave ? (
              <>
                <AppText style={styles.leaveConfirmText}>
                  Leave {conversationTitle(thread)}? You'll stop receiving its messages, and someone still in it has to add you back.
                </AppText>
                <Button label={busy ? "Leaving…" : "Leave group"} variant="secondary" onPress={() => void leave()} disabled={busy} />
                <Button label="Cancel" variant="secondary" onPress={() => setConfirmLeave(false)} />
              </>
            ) : (
              <Pressable style={styles.action} onPress={() => setConfirmLeave(true)}>
                <Icon src={ICONS.block} size={16} color={COLORS.hot} />
                <AppText style={[styles.actionText, styles.danger]}>Leave group</AppText>
              </Pressable>
            )}
          </View>
        </ScrollView>
      </Screen>

      {photo.cropping && <AvatarCropper image={photo.cropping} busy={photo.rendering || busy} onConfirm={photo.applyCrop} onCancel={photo.closeCropper} />}
    </Modal>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 16 },
  headTitle: { fontSize: 16, fontWeight: "700" },
  headAction: { color: COLORS.teal, fontWeight: "700" },
  headActionDisabled: { opacity: 0.4 },
  search: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "#ffffff", borderRadius: 10, marginHorizontal: 16, paddingHorizontal: 10, marginBottom: 12 },
  searchInput: { flex: 1, paddingVertical: 8, fontSize: 14 },
  note: { fontSize: 12, color: COLORS.muted, paddingHorizontal: 16, marginBottom: 8 },
  error: { color: COLORS.hot, fontSize: 12, paddingHorizontal: 16, marginBottom: 8 },
  emptyText: { color: COLORS.muted, textAlign: "center", padding: 24 },
  pickerRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingVertical: 10 },
  pickerWho: { flex: 1 },
  pickerName: { fontWeight: "700", fontSize: 14 },
  pickerHandle: { fontSize: 12, color: COLORS.muted },
  check: { width: 22, height: 22, borderRadius: 11, borderWidth: 1.5, borderColor: COLORS.line, alignItems: "center", justifyContent: "center" },
  checkOn: { backgroundColor: COLORS.teal, borderColor: COLORS.teal },
  hero: { alignItems: "center", padding: 20, gap: 4 },
  photoBadge: {
    position: "absolute",
    right: -2,
    bottom: -2,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: COLORS.teal,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: COLORS.glass,
  },
  heroName: { fontSize: 18, fontWeight: "700", textAlign: "center", marginTop: 10 },
  heroMeta: { fontSize: 12, color: COLORS.muted, textAlign: "center" },
  renameInput: { borderBottomWidth: 1, borderBottomColor: COLORS.line, fontSize: 16, marginTop: 10, minWidth: 160, textAlign: "center" },
  action: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingVertical: 12 },
  actionText: { fontSize: 14, fontWeight: "600" },
  danger: { color: COLORS.hot },
  sectionTitle: { fontSize: 13, fontWeight: "700", color: COLORS.muted, paddingHorizontal: 16, marginTop: 8, marginBottom: 4 },
  memberRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingVertical: 8 },
  leaveSection: { padding: 16, gap: 8 },
  leaveConfirmText: { fontSize: 13, color: COLORS.muted },
});
