"use client";

import { useEffect, useRef, useState } from "react";
import { ERROR_MESSAGES_EN, formatAgoShort, type PostDetail, type PostReply, type ReportReason, type SosoGateway } from "soso-core";
import { Icon, ICONS } from "./Icon";

interface ThoughtThreadProps {
  post: PostDetail;
  gateway: SosoGateway;
  nowSeconds: number;
  onClose: () => void;
  /** Lets the feed list behind this update its own like/reply counts without a full refetch once this closes. */
  onPostChanged: (post: PostDetail) => void;
  /** The post itself was deleted from in here — the feed list should drop it. */
  onPostDeleted: (postId: string) => void;
}

const REPLY_MAX_LENGTH = 500;

const REPORT_REASONS: { label: string; value: ReportReason }[] = [
  { label: "Not true", value: "false_information" },
  { label: "Harassment", value: "harassment" },
  { label: "Privacy", value: "privacy" },
  { label: "Spam", value: "spam" },
];

/**
 * Structurally copied from ChatPanel's own message-list-plus-input
 * pattern — the closest working precedent in this codebase for "a live
 * list of user content plus an input pinned below it" — rather than
 * inventing a different shape for what is, functionally, the same kind of
 * screen.
 *
 * Reply-level reporting is deliberately NOT built here. `reportPost` (the
 * only moderation-report RPC that exists) is generic over `posts.id`, not
 * `post_replies.id` — `moderation_reports.post_id` references `posts`
 * specifically, so a reply cannot be reported through it. The plan's own
 * words for exactly this situation: "explicitly decide to defer it rather
 * than silently shipping without it." Deferred, not covered.
 */
export default function ThoughtThread({ post, gateway, nowSeconds, onClose, onPostChanged, onPostDeleted }: ThoughtThreadProps) {
  const [replies, setReplies] = useState<PostReply[]>([]);
  const [loaded, setLoaded] = useState(false);
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

  const authorAvatarSrc = gateway.avatarUrl(post.author.avatarPath);

  const listRef = useRef<HTMLDivElement>(null);

  async function reload() {
    try {
      const page = await gateway.getPostReplies(post.id);
      setReplies(page);
      setLoadError(false);
    } catch {
      // A failed reload leaves whatever was already showing rather than
      // clearing it, matching ChatPanel's own identical choice — stale
      // replies are a better failure mode than a thread that looks empty.
      setLoadError(replies.length === 0);
    } finally {
      setLoaded(true);
    }
  }

  useEffect(() => {
    void reload();
    // Runs once per opened thread — post.id genuinely can change if this
    // component stays mounted across two different posts, but page.tsx's
    // own wiring always remounts a fresh ThoughtThread per post (a new
    // `key`), so there is no case where the id changes under an existing
    // instance to react to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [replies]);

  async function send() {
    const body = input.trim();
    if (!body || sending) return;
    setSending(true);
    setSendError(null);
    try {
      const reply = await gateway.createPostReply(post.id, body);
      setInput("");
      // Optimistic append, same reasoning as ChatPanel's own send(): there
      // is no realtime signal for a reply in this stage (see the module
      // comment on realtime being scoped to new posts only, not
      // likes/replies — a deliberate, called-out stretch this pass does
      // not build), so without this the sender would not see their own
      // reply appear at all.
      setReplies((prev) => [...prev, reply]);
      onPostChanged({ ...post, replyCount: post.replyCount + 1 });
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
    try {
      await gateway.deletePostReply(replyId);
      onPostChanged({ ...post, replyCount: Math.max(0, post.replyCount - 1) });
    } catch {
      // Reappears on failure rather than a dedicated error state — the
      // same low-stakes, easy-to-notice choice ChatPanel's own delete
      // makes for its messages.
      setReplies(previous);
    }
  }

  // `post.liked`/`post.confirmCount` come from the server (post_detail,
  // backed by post_votes) rather than component-local state, so a like
  // made here is what a reopened thread — or the feed card behind it, via
  // onPostChanged below — shows on its next load, and a second tap undoes
  // it instead of re-casting the same vote (votePost is an upsert with no
  // "remove" of its own; unvotePost is that operation).
  async function toggleLike() {
    if (voting || post.mine) return;
    setVoting(true);
    setVoteError(null);
    const next = !post.liked;
    // Genuinely optimistic, unlike PinPreview's own vote button (which
    // waits for the server before showing anything) — the plan is
    // explicit about this one specifically: "toggle immediately,
    // reconcile on response, roll back on error."
    onPostChanged({ ...post, liked: next, confirmCount: post.confirmCount + (next ? 1 : -1) });
    try {
      if (next) {
        await gateway.votePost(post.id, 1);
      } else {
        await gateway.unvotePost(post.id);
      }
    } catch (err) {
      onPostChanged(post);
      const code = (err as { code?: string }).code;
      setVoteError(code === "soso/cannot_vote_own" ? "That's your own post." : "Couldn't send that — try again.");
    } finally {
      setVoting(false);
    }
  }

  async function confirmRemovePost() {
    setRemoving(true);
    setRemoveError(null);
    try {
      await gateway.resolvePost(post.id);
      onPostDeleted(post.id);
      onClose();
    } catch (err) {
      const code = (err as { code?: string }).code as keyof typeof ERROR_MESSAGES_EN | undefined;
      setRemoveError(code && code in ERROR_MESSAGES_EN ? ERROR_MESSAGES_EN[code] : ERROR_MESSAGES_EN["soso/unknown"]);
    } finally {
      setRemoving(false);
    }
  }

  async function report(reason: ReportReason) {
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

  return (
    <div className="thought-thread" role="dialog" aria-modal="true" aria-label="Post">
      <header className="thought-thread-head">
        <button type="button" className="thought-thread-close" onClick={onClose} aria-label="Close">
          <Icon src={ICONS.close} size={15} />
        </button>
        <strong>Post</strong>
        <span />
      </header>

      <div className="thought-thread-scroll" ref={listRef}>
        <div className="feed-card thought-thread-post">
          <div className="feed-card-avatar" aria-hidden="true">
            {post.author.displayName.trim().charAt(0).toUpperCase() || "?"}
            {authorAvatarSrc && (
              <img src={authorAvatarSrc} alt="" loading="lazy" decoding="async" />
            )}
          </div>
          <div className="feed-card-body">
            <div className="feed-card-byline">
              <strong>{post.author.displayName}</strong>
              <span className="feed-card-handle">@{post.author.handle}</span>
              <span className="feed-card-time">{formatAgoShort(post.createdAt, nowSeconds)}</span>
            </div>
            {post.body && <p className="feed-card-text">{post.body}</p>}
            {/* The same action row FeedTab renders, so a post looks
                identical whether you are reading it in the list or in its
                own thread. The reply icon is inert here on purpose: you
                are already in the replies, and the composer is at the
                bottom of this very screen. */}
            <div className="feed-card-actions">
              <button
                type="button"
                className={`feed-action feed-action-like ${post.liked ? "active" : ""}`}
                disabled={voting || post.mine}
                onClick={() => void toggleLike()}
                aria-pressed={post.liked}
                aria-label={post.liked ? "Undo like" : "Like"}
              >
                <Icon src={post.liked ? ICONS.heartFilled : ICONS.heart} size={22} />
                {post.confirmCount > 0 && <span>{post.confirmCount}</span>}
              </button>
              <span className="feed-action" aria-label={`${post.replyCount} replies`}>
                <Icon src={ICONS.comment} size={22} />
                {post.replyCount > 0 && <span>{post.replyCount}</span>}
              </span>
            </div>
            {voteError && <p className="detail-vote-notice">{voteError}</p>}

            {post.mine && (
              <div className="thought-thread-own">
                {removeConfirmOpen ? (
                  <div className="detail-remove-confirm">
                    <p>This removes your post immediately. This can't be undone.</p>
                    <div className="detail-remove-confirm-actions">
                      <button type="button" onClick={() => setRemoveConfirmOpen(false)} disabled={removing}>
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="detail-remove-confirm-yes"
                        onClick={() => void confirmRemovePost()}
                        disabled={removing}
                      >
                        {removing ? "Removing…" : "Yes, remove it"}
                      </button>
                    </div>
                    {removeError && <p className="detail-vote-notice">{removeError}</p>}
                  </div>
                ) : (
                  <button
                    className="pin-preview-primary-action pin-preview-remove-action"
                    type="button"
                    onClick={() => setRemoveConfirmOpen(true)}
                  >
                    Remove this now
                  </button>
                )}
              </div>
            )}

            {!post.mine && (
              <div className="pin-preview-links">
                {reported ? (
                  <p className="detail-own">Reported — thanks, we&rsquo;ll look at it.</p>
                ) : reportOpen ? (
                  <div className="detail-report-reasons">
                    {REPORT_REASONS.map((r) => (
                      <button key={r.value} type="button" onClick={() => void report(r.value)}>
                        {r.label}
                      </button>
                    ))}
                  </div>
                ) : (
                  <button className="detail-report-link" type="button" onClick={() => setReportOpen(true)}>
                    Report this post
                  </button>
                )}
                {reportError && <p className="detail-vote-notice">{reportError}</p>}
              </div>
            )}
          </div>
        </div>

        <div className="thought-thread-replies">
          {!loaded ? (
            <p className="chat-empty">Loading…</p>
          ) : loadError ? (
            <p className="chat-empty">Couldn't load replies.</p>
          ) : replies.length === 0 ? (
            <p className="chat-empty">No replies yet — be the first.</p>
          ) : (
            replies.map((r) => (
              // The same bubbles ChatPanel renders (see .thought-thread-replies
              // in globals.css) — a reply thread and a chat are the same
              // thing on screen, and this view already borrowed that
              // component's shape wholesale before the bubbles were
              // redesigned. What it does NOT borrow is the long-press
              // action sheet: reactions and replies-to-replies do not
              // exist for post replies (no post_reply_reactions table, no
              // parent column), so a sheet here would be one live action —
              // delete — behind a hidden gesture. Hence the small ✕ beside
              // your own reply instead.
              <div key={r.id} className={`chat-row ${r.mine ? "mine" : "theirs"} run-end`}>
                {!r.mine && (
                  <div className="chat-row-avatar" aria-hidden="true">
                    {(r.authorName || r.authorHandle).trim().charAt(0).toUpperCase() || "?"}
                    {gateway.avatarUrl(r.authorAvatarPath) && (
                      <img
                        src={gateway.avatarUrl(r.authorAvatarPath) as string}
                        alt=""
                        loading="lazy"
                        decoding="async"
                      />
                    )}
                  </div>
                )}
                <div className="chat-row-stack">
                  {!r.mine && <span className="chat-row-author">{r.authorName || r.authorHandle}</span>}
                  <div className="chat-row-bubble-line">
                    <div className="chat-bubble">
                      <span className="chat-bubble-text">{r.body}</span>
                    </div>
                    {r.mine && (
                      <button
                        className="chat-row-delete"
                        type="button"
                        onClick={() => void removeReply(r.id)}
                        aria-label="Delete reply"
                      >
                        <Icon src={ICONS.close} size={10} />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {sendError && <p className="chat-error">{sendError}</p>}

      <form
        className="chat-compose"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <input
          className="chat-input"
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Reply…"
          maxLength={REPLY_MAX_LENGTH}
          aria-label="Reply"
        />
        <button className="chat-send" type="submit" disabled={sending || input.trim().length === 0} aria-label="Send">
          <Icon src={ICONS.send} size={16} />
        </button>
      </form>
    </div>
  );
}
