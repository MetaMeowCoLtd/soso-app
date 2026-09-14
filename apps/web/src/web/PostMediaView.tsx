"use client";

import { useEffect, useState } from "react";
import type { PostMedia, SosoGateway } from "soso-core";
import { Icon, ICONS } from "./Icon";

/**
 * The photo or clip attached to a post.
 *
 * A sibling of `MessageMediaView` rather than a reuse of it, and the reason
 * is authorization rather than looks. A message attachment's readability
 * follows thread membership, which its object key encodes, so
 * `MessageMediaView` can batch a whole conversation's URLs in one call keyed
 * by path. A post attachment's readability follows the POST's audience,
 * which the key does not encode — the Edge Function has to resolve each key
 * back to its post (see `may_read_post_media`) — so batching buys nothing
 * and the caching story is different.
 *
 * Sharing one component would have meant one of the two pretending its
 * authorization model was the other's. They share the presign endpoint and
 * the play-badge CSS, which is the part that was actually worth sharing.
 *
 * WHY A VIDEO SHOWS ITS POSTER FIRST
 * ---------------------------------------------------------------------
 * Same reason as in a conversation: a feed may scroll past twenty posts and
 * play none of them, and minting URLs for twenty videos so the browser can
 * start buffering all of them is a cost nobody asked for. The clip's own URL
 * is requested on the first tap.
 */

interface PostMediaViewProps {
  gateway: SosoGateway;
  media: PostMedia;
  /** Width the card gives it; the height follows the stored aspect ratio. */
  availableWidth: number;
  /** Cap, so a tall portrait clip cannot push the rest of a card off screen. */
  maxHeight?: number;
}

export default function PostMediaView({
  gateway,
  media,
  availableWidth,
  maxHeight = 420,
}: PostMediaViewProps) {
  const thumbKey = media.kind === "video" ? media.posterKey! : media.objectKey;
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const [clipUrl, setClipUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const urls = await gateway.messageMediaUrls([thumbKey]);
        if (!cancelled) setThumbUrl(urls[thumbKey] ?? null);
      } catch {
        if (!cancelled) setThumbUrl(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [gateway, thumbKey]);

  // Fetched only once someone presses play.
  useEffect(() => {
    if (!playing || media.kind !== "video" || clipUrl) return;
    let cancelled = false;
    void (async () => {
      try {
        const urls = await gateway.messageMediaUrls([media.objectKey]);
        if (!cancelled) setClipUrl(urls[media.objectKey] ?? null);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [playing, media.kind, media.objectKey, clipUrl, gateway]);

  const ratio = media.width > 0 && media.height > 0 ? media.height / media.width : 0.75;
  const height = Math.min(Math.round(availableWidth * ratio), maxHeight);
  const style = { width: "100%", height };

  if (loading) {
    return <span className="post-media skeleton-block" style={style} aria-hidden="true" />;
  }

  // A null URL is the honest outcome for a post this viewer may no longer
  // see, or an object that never landed. Same treatment either way, and not
  // an error worth interrupting a feed over.
  if (!thumbUrl || failed) {
    return (
      <span className="post-media post-media-missing" style={style}>
        {media.kind === "video" ? "Video unavailable" : "Image unavailable"}
      </span>
    );
  }

  if (media.kind === "video" && playing) {
    return (
      <span className="post-media post-media-playing" style={style}>
        {clipUrl ? (
          <video
            src={clipUrl}
            poster={thumbUrl}
            controls
            autoPlay
            // Required on iOS, or play hands the clip to the fullscreen
            // system player and takes the person out of the feed.
            playsInline
            preload="metadata"
          />
        ) : (
          // The poster stays while the clip's URL is minted, so the tap does
          // not blank the card it was aimed at.
          <img src={thumbUrl} alt="" className="post-media-poster" />
        )}
      </span>
    );
  }

  if (media.kind === "image") {
    return (
      <span className="post-media" style={style}>
        <img src={thumbUrl} alt="" onError={() => setFailed(true)} />
      </span>
    );
  }

  return (
    <button
      type="button"
      className="post-media post-media-button"
      style={style}
      onClick={() => setPlaying(true)}
      aria-label="Play video"
    >
      <img src={thumbUrl} alt="" onError={() => setFailed(true)} />
      <span className="message-video-play" aria-hidden="true">
        <Icon src={ICONS.play} size={24} />
      </span>
      {media.durationMs !== null && (
        <span className="message-video-duration" aria-hidden="true">
          {formatClipLength(media.durationMs)}
        </span>
      )}
    </button>
  );
}

function formatClipLength(durationMs: number): string {
  const total = Math.max(0, Math.round(durationMs / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
