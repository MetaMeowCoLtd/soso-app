import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, View } from "react-native";

import { ChatTextarea } from "../chat/ChatTextarea";
import { ERROR_MESSAGES_EN, formatAgoShort, type PostDetail, type PostReply, type ReportReason } from "../core";
import { useGateway } from "../gate/AppGate";
import PostMediaView from "../media/PostMediaView";
import type { RootStackParamList } from "../navigation/types";
import { Icon, ICONS } from "../theme/Icon";
import { COLORS } from "../theme/tokens";
import { AppText } from "../ui/AppText";
import { Avatar } from "../ui/Avatar";
import { Button } from "../ui/Button";
import { Screen } from "../ui/Screen";

/**
 * Ported from apps/web/src/web/ThoughtThread.tsx. One screen for both of the
 * web version's two overlays (a location-optional "thought" pin, and any
 * post's comment icon) — see navigation/types.ts's note on why `mode` is a
 * param rather than two routes. Web renders the exact same component either
 * way; `mode` here only changes the header title ("Thread" vs "Comments"),
 * matching the only thing the placeholder this replaces already did with it.
 *
 * Deliberately NOT built on ConversationView/MessageBubble (chat's own
 * list+composer pair) — a `PostReply` has no reactions, no mentions, no
 * media, and no reply-to-a-reply (flat, one level deep; see
 * packages/core/src/domain/types.ts's own comment on post_replies). Forcing
 * it through the chat components would mean padding out a shape they don't
 * have just to satisfy props they don't need. This is a smaller, bespoke
 * list+composer instead, the same relationship web's own ThoughtThread.tsx
 * has to ChatPanel: "structurally copied," not reused.
 *
 * No realtime for replies here, on purpose — `SosoGateway` has no
 * subscribeRepliesChanged, and web's own version doesn't poll for one
 * either. A reply only ever appears via this screen's own optimistic
 * append; someone else's reply shows up the next time this thread is
 * reopened.
 */
const REPLY_MAX_LENGTH = 500;

const REPORT_REASONS: { label: string; value: ReportReason }[] = [
  { label: "Not true", value: "false_information" },
  { label: "Harassment", value: "harassment" },
  { label: "Privacy", value: "privacy" },
  { label: "Spam", value: "spam" },
];

export default function ThoughtThreadScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { params } = useRoute<RouteProp<RootStackParamList, "ThoughtThread">>();
  const gateway = useGateway();
  const listRef = useRef<FlatList<PostReply>>(null);

  const [nowSeconds, setNowSeconds] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNowSeconds(Math.floor(Date.now() / 1000)), 15_000);
    return () => clearInterval(id);
  }, []);

  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [post, setPost] = useState<PostDetail | null>(null);

  const [replies, setReplies] = useState<PostReply[]>([]);
  const [repliesLoaded, setRepliesLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);

  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const [voting, setVoting] = useState(false);
  const [voteError, setVoteError] = useState<string | null>(null);

  const [removeConfirmOpen, setRemoveConfirmOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const [reportOpen, setReportOpen] = useState(false);
  const [reported, setReported] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setNotFound(false);
    gateway
      .postDetail(params.postId)
      .then((detail) => {
        if (!alive) return;
        if (detail) setPost(detail);
        else setNotFound(true);
      })
      .catch(() => {
        if (alive) setNotFound(true);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [gateway, params.postId]);

  useEffect(() => {
    let alive = true;
    gateway
      .getPostReplies(params.postId)
      .then((rows) => {
        if (alive) setReplies(rows);
      })
      .catch(() => {
        // Stale/empty list kept on screen, same as web — only worth calling
        // out as an error if there was nothing to show in the first place.
        setReplies((prev) => {
          if (prev.length === 0) setLoadError(true);
          return prev;
        });
      })
      .finally(() => {
        if (alive) setRepliesLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, [gateway, params.postId]);

  // Mirrors web's "auto-scroll the list to the bottom whenever replies
  // change" — a thread only ever grows at the end (oldest-first, flat, no
  // jump-to-reply the way chat has), so there's no scroll-position policy
  // to preserve the way useChatScroll has to for a live chat.
  useEffect(() => {
    if (repliesLoaded && replies.length > 0) {
      requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: false }));
    }
  }, [replies.length, repliesLoaded]);

  async function toggleLike() {
    if (!post || voting || post.mine) return;
    setVoting(true);
    setVoteError(null);
    const previous = post;
    const next = !post.liked;
    setPost({ ...post, liked: next, confirmCount: post.confirmCount + (next ? 1 : -1) });
    try {
      if (next) await gateway.votePost(post.id, 1);
      else await gateway.unvotePost(post.id);
    } catch (err) {
      setPost(previous);
      const code = (err as { code?: string }).code;
      setVoteError(code === "soso/cannot_vote_own" ? "That's your own post." : "Couldn't send that — try again.");
    } finally {
      setVoting(false);
    }
  }

  async function confirmRemove() {
    if (!post) return;
    setRemoving(true);
    setRemoveError(null);
    try {
      await gateway.resolvePost(post.id);
      // Matches web exactly: removing your own post closes the thread
      // immediately rather than lingering on a "removed" message.
      navigation.goBack();
    } catch {
      setRemoveError("Couldn't remove that — try again.");
      setRemoving(false);
    }
  }

  async function report(reason: ReportReason) {
    if (!post) return;
    setReportOpen(false);
    setReportError(null);
    try {
      await gateway.reportPost(post.id, reason);
      setReported(true);
    } catch (err) {
      const code = (err as { code?: string }).code as keyof typeof ERROR_MESSAGES_EN | undefined;
      setReportError(code && code in ERROR_MESSAGES_EN ? ERROR_MESSAGES_EN[code] : ERROR_MESSAGES_EN["soso/unknown"]);
    }
  }

  async function send() {
    if (!post) return;
    const body = input.trim();
    if (!body || sending) return;
    setSending(true);
    setSendError(null);
    try {
      const reply = await gateway.createPostReply(post.id, body);
      setReplies((prev) => [...prev, reply]);
      setInput("");
      setPost((prev) => (prev ? { ...prev, replyCount: prev.replyCount + 1 } : prev));
    } catch (err) {
      const code = (err as { code?: string }).code as keyof typeof ERROR_MESSAGES_EN | undefined;
      setSendError(code && code in ERROR_MESSAGES_EN ? ERROR_MESSAGES_EN[code] : ERROR_MESSAGES_EN["soso/unknown"]);
    } finally {
      setSending(false);
    }
  }

  async function removeReply(replyId: string) {
    const previous = replies;
    setReplies((prev) => prev.filter((r) => r.id !== replyId));
    setPost((prev) => (prev ? { ...prev, replyCount: Math.max(0, prev.replyCount - 1) } : prev));
    try {
      await gateway.deletePostReply(replyId);
    } catch {
      setReplies(previous);
      setPost((prev) => (prev ? { ...prev, replyCount: prev.replyCount + 1 } : prev));
    }
  }

  return (
    <Screen edges={["top", "bottom"]}>
      <View style={styles.header}>
        <Pressable onPress={() => navigation.goBack()} accessibilityLabel="Back" style={styles.headerButton}>
          <Icon src={ICONS.chevronLeft} size={17} color={COLORS.ink} />
        </Pressable>
        <AppText style={styles.headerTitle}>{params.mode === "comments" ? "Comments" : "Thread"}</AppText>
        <View style={styles.headerButton} />
      </View>

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator />
        </View>
      ) : notFound || !post ? (
        <View style={styles.centered}>
          <AppText style={styles.status}>This post isn't available.</AppText>
        </View>
      ) : (
        <KeyboardAvoidingView style={styles.flex1} behavior={Platform.OS === "ios" ? "padding" : "height"}>
          <FlatList
            ref={listRef}
            style={styles.flex1}
            data={replies}
            keyExtractor={(reply) => reply.id}
            contentContainerStyle={styles.listContent}
            ListHeaderComponent={
              <View>
                <View style={styles.postCard}>
                  <View style={styles.postByline}>
                    <Avatar name={post.author.displayName} seed={post.author.handle} src={gateway.avatarUrl(post.author.avatarPath)} size={40} />
                    <View style={styles.postBylineText}>
                      <AppText style={styles.postAuthorName}>{post.author.displayName}</AppText>
                      <AppText style={styles.postAuthorHandle}>@{post.author.handle}</AppText>
                    </View>
                    <AppText style={styles.postTime}>{formatAgoShort(post.createdAt, nowSeconds)}</AppText>
                  </View>

                  {post.body && <AppText style={styles.postBody}>{post.body}</AppText>}

                  {post.media[0] && (
                    <View style={styles.postMediaWrap}>
                      <PostMediaView gateway={gateway} media={post.media[0]} maxHeight={280} />
                    </View>
                  )}

                  <View style={styles.postActions}>
                    <Pressable
                      style={styles.postActionButton}
                      disabled={voting || post.mine}
                      onPress={() => void toggleLike()}
                      accessibilityLabel={post.liked ? "Undo like" : "Like"}
                    >
                      <Icon src={post.liked ? ICONS.heartFilled : ICONS.heart} size={20} color={post.liked ? COLORS.hot : COLORS.muted} />
                      {post.confirmCount > 0 && <AppText style={styles.postActionCount}>{post.confirmCount}</AppText>}
                    </Pressable>
                    {/* Inert — unlike the feed card's own comment icon, tapping this can't
                        open the thread a second time when it's already what's open. */}
                    <View style={styles.postActionButton}>
                      <Icon src={ICONS.comment} size={20} color={COLORS.muted} />
                      {post.replyCount > 0 && <AppText style={styles.postActionCount}>{post.replyCount}</AppText>}
                    </View>
                  </View>
                  {voteError && <AppText style={styles.notice}>{voteError}</AppText>}

                  {post.mine ? (
                    <View style={styles.ownSection}>
                      {removeConfirmOpen ? (
                        <View>
                          <AppText style={styles.notice}>This removes your post immediately. This can't be undone.</AppText>
                          <View style={styles.confirmRow}>
                            <Button label="Cancel" variant="secondary" onPress={() => setRemoveConfirmOpen(false)} disabled={removing} />
                            <Button label={removing ? "Removing…" : "Yes, remove it"} onPress={() => void confirmRemove()} disabled={removing} />
                          </View>
                          {removeError && <AppText style={styles.notice}>{removeError}</AppText>}
                        </View>
                      ) : (
                        <Button label="Remove this now" variant="secondary" onPress={() => setRemoveConfirmOpen(true)} style={styles.smallButton} />
                      )}
                    </View>
                  ) : (
                    <View style={styles.reportSection}>
                      {reported ? (
                        <AppText style={styles.reportedText}>Reported — thanks, we'll look at it.</AppText>
                      ) : reportOpen ? (
                        <View style={styles.reportReasons}>
                          {REPORT_REASONS.map((reason) => (
                            <Button
                              key={reason.value}
                              label={reason.label}
                              variant="secondary"
                              onPress={() => void report(reason.value)}
                              style={styles.smallButton}
                            />
                          ))}
                        </View>
                      ) : (
                        <Button label="Report this post" variant="secondary" onPress={() => setReportOpen(true)} style={styles.smallButton} />
                      )}
                      {reportError && <AppText style={styles.notice}>{reportError}</AppText>}
                    </View>
                  )}
                </View>

                <AppText style={styles.repliesHeading}>Replies</AppText>

                {!repliesLoaded ? (
                  <View style={styles.centered}>
                    <ActivityIndicator />
                  </View>
                ) : loadError ? (
                  <AppText style={styles.status}>Couldn't load replies.</AppText>
                ) : replies.length === 0 ? (
                  <AppText style={styles.status}>No replies yet — be the first.</AppText>
                ) : null}
              </View>
            }
            renderItem={({ item }) => (
              <View style={[styles.replyRow, item.mine ? styles.replyRowMine : styles.replyRowTheirs]}>
                {!item.mine && <Avatar name={item.authorName} seed={item.authorHandle} src={gateway.avatarUrl(item.authorAvatarPath)} size={26} />}
                <View style={styles.replyStack}>
                  {!item.mine && <AppText style={styles.replyAuthor}>{item.authorName}</AppText>}
                  <View style={styles.replyBubbleLine}>
                    {item.mine && (
                      <Pressable onPress={() => void removeReply(item.id)} accessibilityLabel="Delete reply" style={styles.replyDelete}>
                        <Icon src={ICONS.close} size={12} color={COLORS.muted} />
                      </Pressable>
                    )}
                    <View style={[styles.replyBubble, item.mine ? styles.replyBubbleMine : styles.replyBubbleTheirs]}>
                      <AppText style={[styles.replyText, item.mine && styles.replyTextMine]}>{item.body}</AppText>
                    </View>
                  </View>
                </View>
              </View>
            )}
          />

          {sendError && <AppText style={styles.error}>{sendError}</AppText>}

          <View style={styles.composer}>
            <ChatTextarea value={input} onChange={setInput} placeholder="Reply…" maxLength={REPLY_MAX_LENGTH} ariaLabel="Reply" />
            <Pressable
              style={[styles.sendButton, (sending || input.trim().length === 0) && styles.sendButtonDisabled]}
              onPress={() => void send()}
              disabled={sending || input.trim().length === 0}
              accessibilityLabel="Send"
            >
              <Icon src={ICONS.send} size={16} color="#ffffff" />
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex1: { flex: 1 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  status: { color: COLORS.muted, textAlign: "center", padding: 16 },
  header: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingVertical: 10 },
  headerButton: { padding: 4, width: 25 },
  headerTitle: { flex: 1, textAlign: "center", fontSize: 15, fontWeight: "700" },
  listContent: { paddingBottom: 8 },
  postCard: { padding: 16, borderBottomWidth: 8, borderBottomColor: COLORS.hairline },
  postByline: { flexDirection: "row", alignItems: "center", gap: 10 },
  postBylineText: { flex: 1 },
  postAuthorName: { fontWeight: "700", fontSize: 14 },
  postAuthorHandle: { fontSize: 12, color: COLORS.muted },
  postTime: { fontSize: 12, color: COLORS.muted },
  postBody: { fontSize: 15, marginTop: 10, lineHeight: 20 },
  postMediaWrap: { marginTop: 10 },
  postActions: { flexDirection: "row", gap: 20, marginTop: 12 },
  postActionButton: { flexDirection: "row", alignItems: "center", gap: 4 },
  postActionCount: { fontSize: 12, color: COLORS.muted },
  notice: { fontSize: 12, color: COLORS.hot, marginTop: 8 },
  ownSection: { marginTop: 10 },
  confirmRow: { flexDirection: "row", gap: 8, marginTop: 8 },
  reportSection: { marginTop: 10 },
  reportedText: { fontSize: 13, color: COLORS.muted },
  reportReasons: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  smallButton: { paddingHorizontal: 12, paddingVertical: 6, alignSelf: "flex-start" },
  repliesHeading: { fontSize: 13, fontWeight: "700", color: COLORS.muted, paddingHorizontal: 16, marginTop: 14, marginBottom: 4 },
  replyRow: { flexDirection: "row", gap: 8, marginTop: 8, paddingHorizontal: 12 },
  replyRowMine: { justifyContent: "flex-end" },
  replyRowTheirs: { justifyContent: "flex-start" },
  replyStack: { maxWidth: "78%", gap: 2 },
  replyAuthor: { fontSize: 11, fontWeight: "700", color: COLORS.muted, marginLeft: 4 },
  replyBubbleLine: { flexDirection: "row", alignItems: "center", gap: 4 },
  replyBubble: { borderRadius: 16, paddingHorizontal: 12, paddingVertical: 8 },
  replyBubbleMine: { backgroundColor: COLORS.teal },
  replyBubbleTheirs: { backgroundColor: "rgba(20,50,43,0.06)" },
  replyText: { fontSize: 15, color: COLORS.ink },
  replyTextMine: { color: "#ffffff" },
  replyDelete: { padding: 4 },
  error: { color: COLORS.hot, fontSize: 12, paddingHorizontal: 12, paddingBottom: 4 },
  composer: { flexDirection: "row", alignItems: "flex-end", gap: 8, padding: 8 },
  sendButton: { width: 36, height: 36, borderRadius: 18, backgroundColor: COLORS.teal, alignItems: "center", justifyContent: "center" },
  sendButtonDisabled: { opacity: 0.4 },
});
