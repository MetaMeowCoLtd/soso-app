"use client";

import { useEffect, useRef, useState } from "react";
import { ERROR_MESSAGES_EN, formatAgo, type PostDetail, type PostReply, type ReportReason, type SosoGateway } from "soso-core";

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

  const [liked, setLiked] = useState(false);
  const [confirmCount, setConfirmCount] = useState(post.confirmCount);
  const [voting, setVoting] = useState(false);
  const [voteError, setVoteError] = useState<string | null>(null);

  const [removeConfirmOpen, setRemoveConfirmOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const [reportOpen, setReportOpen] = useState(false);
  const [reported, setReported] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);

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

  async function toggleLike() {
    if (voting || post.mine) return;
    setVoting(true);
    setVoteError(null);
    const next = !liked;
    // Genuinely optimistic, unlike PinPreview's own vote button (which
    // waits for the server before showing anything) — the plan is
    // explicit about this one specifically: "toggle immediately,
    // reconcile on response, roll back on error."
    setLiked(next);
    setConfirmCount((c) => c + (next ? 1 : -1));
    try {
      await gateway.votePost(post.id, 1);
    } catch (err) {
      setLiked(!next);
      setConfirmCount((c) => c - (next ? 1 : -1));
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
          ✕
        </button>
        <strong>Post</strong>
        <span />
      </header>

      <div className="thought-thread-scroll" ref={listRef}>
        <div className="feed-card thought-thread-post">
          <div className="feed-card-avatar" aria-hidden="true">
            {post.author.displayName.trim().charAt(0).toUpperCase() || "?"}
          </div>
          <div className="feed-card-body">
            <div className="feed-card-byline">
              <strong>{post.author.displayName}</strong>
              <span className="feed-card-handle">@{post.author.handle}</span>
              <span className="feed-card-dot">·</span>
              <span className="feed-card-time">{formatAgo(post.createdAt, nowSeconds)}</span>
            </div>
            {post.body && <p className="feed-card-text">{post.body}</p>}
            <div className="feed-card-meta">
              <button
                type="button"
                className={`feed-like-button ${liked ? "active" : ""}`}
                disabled={voting || post.mine}
                onClick={() => void toggleLike()}
                aria-pressed={liked}
              >
                👍 {confirmCount}
              </button>
              <span>💬 {post.replyCount}</span>
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
              <div key={r.id} className={`chat-message ${r.mine ? "mine" : ""}`}>
                <div className="chat-message-meta">
                  <span className="chat-message-author">{r.mine ? "You" : r.authorName || r.authorHandle}</span>
                  <span className="chat-message-time">
                    {formatAgo(Math.floor(new Date(r.createdAt).getTime() / 1000), nowSeconds)}
                  </span>
                </div>
                <span className="chat-message-body">{r.body}</span>
                {r.mine && (
                  <button className="chat-message-delete" type="button" onClick={() => void removeReply(r.id)}>
                    Delete
                  </button>
                )}
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
          <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 10h13M10 3l7 7-7 7" />
          </svg>
        </button>
      </form>
    </div>
  );
}
