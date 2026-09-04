"use client";

import { useState } from "react";
import {
  ERROR_MESSAGES_EN,
  canAffordPost,
  POST_PIN_COST,
  type NewPost,
  type PostAudience,
  type PostDetail,
  type SosoGateway,
} from "soso-core";

interface ThoughtComposerProps {
  gateway: SosoGateway;
  coinBalance: number | null;
  onCancel: () => void;
  onPosted: (post: PostDetail) => void;
}

const BODY_MAX_LENGTH = 500;

/**
 * The concrete UI expression of `post_categories.requires_location = false`
 * (see migration 0023): this composer never asks for or shows a place, on
 * purpose — no map tap, no device-location capture, no proximity trigger
 * anywhere in here. A category the client has to specifically choose not
 * to add location chrome to is the wrong shape for this; the absence is
 * structural, not a step this component skips.
 *
 * Reuses the pin composer's own audience-picker markup and options
 * (`.audience-picker`/`.audience-option`, `public`/`friends`/
 * `close_friends`) rather than inventing a second one — see
 * ReportForm.tsx, which is the actual source of that pattern.
 *
 * No image attachment field, despite the plan's own "optional single
 * image" — `post_media` has no upload path anywhere in this app yet (the
 * table exists, nothing writes to it), and there is no established
 * convention anywhere in this codebase for turning a file into a stored
 * object key. Building a composer field with nothing real behind it felt
 * worse than a composer that is honest about only doing what already
 * works end to end.
 */
export default function ThoughtComposer({ gateway, coinBalance, onCancel, onPosted }: ThoughtComposerProps) {
  const [body, setBody] = useState("");
  const [audience, setAudience] = useState<PostAudience>("public");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canAfford = coinBalance === null || canAffordPost(coinBalance);
  const trimmed = body.trim();
  const canSubmit = trimmed.length > 0 && trimmed.length <= BODY_MAX_LENGTH && !busy && canAfford;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const input: NewPost = { category: "thought", body: trimmed, audience };
      const pin = await gateway.createPost(input);
      // createPost's own return is a lightweight Pin, not the full
      // PostDetail a feed card needs (author name/handle, reply count,
      // the `mine` flag) — post_detail is what already builds that exact
      // shape for one post elsewhere in this app, so it is reused here
      // rather than re-deriving those fields by hand from what's already
      // known locally (the caller's own identity, an empty reply count),
      // which would silently drift from the server's own definition of a
      // PostDetail the moment either side changed.
      const detail = await gateway.postDetail(pin.id);
      if (detail) {
        onPosted(detail);
      } else {
        // Genuinely shouldn't happen — a post was just created by this
        // same caller, so soso.can_see_post's own-author branch always
        // allows it. Falling back to closing the composer rather than
        // showing a confusing error for a state that isn't actually
        // reachable in practice.
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
    <div className="composer-backdrop" role="dialog" aria-modal="true" aria-label="New post">
      <div className="thought-composer">
        <header className="thought-composer-head">
          <button type="button" className="thought-composer-cancel" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <strong>New post</strong>
          <button
            type="button"
            className="share-button thought-composer-post"
            onClick={() => void submit()}
            disabled={!canSubmit}
          >
            {busy ? "Posting…" : "Post"}
          </button>
        </header>

        <textarea
          className="thought-composer-body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="What's on your mind?"
          maxLength={BODY_MAX_LENGTH}
          autoFocus
          rows={6}
        />
        <div className="thought-composer-count">
          {trimmed.length}/{BODY_MAX_LENGTH}
        </div>

        <div className="audience-picker" role="group" aria-label="Who can see this">
          <span className="audience-label">Visible to</span>
          <div className="audience-options">
            {(
              [
                { key: "public", label: "Everyone", hint: "Anyone using SoSo here" },
                { key: "friends", label: "Friends", hint: "People you both follow" },
                { key: "close_friends", label: "Close friends", hint: "Friends you marked close" },
              ] as const
            ).map((option) => (
              <button
                key={option.key}
                type="button"
                className={`audience-option ${audience === option.key ? "selected" : ""}`}
                onClick={() => setAudience(option.key)}
                aria-pressed={audience === option.key}
                title={option.hint}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <p className="composer-meta">
          Costs <strong>{POST_PIN_COST} 🪙</strong>
        </p>

        {(error || !canAfford) && (
          <p className="form-errors" role="alert">
            {error ?? ERROR_MESSAGES_EN["soso/insufficient_coins"]}
          </p>
        )}
      </div>
    </div>
  );
}
