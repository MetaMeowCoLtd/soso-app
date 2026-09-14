"use client";

import { useState } from "react";
import type { PostMedia, SosoGateway } from "soso-core";
import { Icon, ICONS } from "./Icon";
import { useMessageImageUrl } from "./MessageMediaView";

/**
 * The photo or clip attached to a post.
 *
 * A separate component from `MessageMediaView` because the two LOOK
 * different — a post's media is a full-width card, a message's is a bubble
 * with a lightbox — and because their authorization differs underneath: a
 * message key encodes its thread, while a post key encodes only its author
 * and has to be resolved back to its post (see `may_read_post_media`).
 *
 * None of that is a reason to fetch differently, which is what this used to
 * do. Resolving a path to a URL is the same problem on both surfaces, so it
 * now goes through the same `useMessageImageUrl` — which means post media
 * gets the request batching and the on-device cache that message media
 * already had, and silently did not before.
 *
 * Sharing one component would have meant one of the two pretending its
 * authorization model was the other's. They share the presign endpoint, the
 * play-badge CSS, and `useMessageImageUrl` — which is the part that was
 * actually worth sharing, and which this used to duplicate. Doing its own
 * fetching meant post media silently missed the on-device cache and the
 * request batching that every message image already had.
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
  /**
   * Cap on how tall the attachment may render, so a portrait shot cannot
   * push the rest of a card off screen.
   *
   * The WIDTH is not a prop and deliberately cannot be: it is whatever the
   * card gives it, which CSS already knows and this component does not. It
   * used to take an `availableWidth`, and every one of its three callers
   * passed a hardcoded 320 — which was wrong on any viewport wider than
   * that, and wrong in a way that silently cropped: the box's height was
   * computed from the fake 320 while its width stretched to the card's real
   * one, so the box's aspect ratio had nothing to do with the image's and
   * `object-fit: cover` cut away the difference.
   */
  maxHeight?: number;
}

export default function PostMediaView({
  gateway,
  media,
  maxHeight = 420,
}: PostMediaViewProps) {
  const thumbKey = media.kind === "video" ? media.posterKey! : media.objectKey;
  const [failed, setFailed] = useState(false);
  const [playing, setPlaying] = useState(false);

  const { url: thumbUrl, loading } = useMessageImageUrl(gateway, thumbKey);
  // Null until someone presses play, which is what keeps a feed of videos
  // from minting URLs — and downloading bytes — for clips nobody watches.
  const { url: clipUrl } = useMessageImageUrl(
    gateway,
    playing && media.kind === "video" ? media.objectKey : null,
  );

  /**
   * The image's own shape, handed to CSS rather than resolved to pixels here.
   *
   * `aspect-ratio` plus a `max-height` is what keeps the frame honest at any
   * card width: the browser derives the height from whatever width the card
   * actually hands over, and the stylesheet shrinks the width to match when
   * the cap bites, so the frame is always the picture's own shape and there
   * is never a mismatch for `object-fit` to crop away.
   *
   * 4:3 stands in for media stored without usable dimensions — rare, and a
   * frame of roughly the right shape beats a collapsed one.
   */
  const style = {
    aspectRatio: media.width > 0 && media.height > 0 ? `${media.width} / ${media.height}` : "4 / 3",
    maxHeight,
  };

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
