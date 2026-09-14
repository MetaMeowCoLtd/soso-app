/**
 * Rules for a video attached to a message or a post.
 *
 * The pure half, same split as `message-image.ts`: what may be picked, what
 * the re-encoded result should look like, and whether a given file even
 * needs re-encoding all live here and are tested here. The WebCodecs work
 * that needs a browser lives in apps/web/src/web/videoEncode.ts.
 *
 * WHY THERE IS A CLIENT-SIDE ENCODE AT ALL
 * ---------------------------------------------------------------------
 * There is no server-side transcoding pipeline and there is deliberately
 * not going to be one — no Cloudflare Stream, no ffmpeg worker, no storage
 * bill that scales with what people happen to film. So the only place a
 * video can be made small is the device that produced it, before it is ever
 * uploaded. That is the same thing the Instagram and Facebook apps do first,
 * for the same reason: a minute of iPhone 4K is a few hundred megabytes, and
 * uploading that fails far more often than it succeeds.
 *
 * What this app does NOT get from that comparison is the rest of their
 * pipeline — a per-title bitrate ladder, adaptive streaming, a CDN, and in
 * Meta's case custom silicon to make the encoding affordable. One file is
 * stored and one file is served to everyone. That is why the ceilings below
 * are tight where theirs are generous, and it is a property of the
 * architecture rather than a number someone can simply raise.
 *
 * WHY A PASS-THROUGH PATH EXISTS
 * ---------------------------------------------------------------------
 * Re-encoding is lossy and slow, and a good fraction of what people actually
 * send has already been encoded by something else — a clip saved from
 * another app, a screen recording, a video that has already been through
 * this pipeline once. `videoNeedsReencode` is what keeps those untouched:
 * generational loss from re-encoding an already-small file buys nothing.
 */

/**
 * Longest edge of the encoded result.
 *
 * 1280 rather than the image path's 1600. A still is read — sometimes it is
 * a screenshot of text — while a video is watched, and the bitrate needed to
 * keep 1080p from smearing in motion costs far more than the sharpness is
 * worth when the file has to stand alone with no quality ladder behind it.
 */
export const MESSAGE_VIDEO_MAX_DIMENSION = 1280;

/**
 * Target video bitrate for the re-encode, in bits per second.
 *
 * ~2.5 Mbps at 720p is around the bottom of "looks fine on a phone" for
 * general content and puts a 60-second clip near 20 MB including audio.
 * Deliberately a fixed number rather than per-title: choosing a bitrate from
 * the content is exactly the expensive analysis this app has no budget for.
 */
export const MESSAGE_VIDEO_BITRATE = 2_500_000;

/** Audio is re-encoded too; 128 kbps AAC is transparent enough for speech and ambient sound. */
export const MESSAGE_VIDEO_AUDIO_BITRATE = 128_000;

/**
 * Frame rate ceiling. A 60fps clip is halved rather than sent as-is: at this
 * bitrate the extra frames cost more than they show.
 */
export const MESSAGE_VIDEO_MAX_FPS = 30;

/**
 * How long a clip may be.
 *
 * The binding constraint is not storage, it is that encoding happens on the
 * sender's phone while they wait. Sixty seconds is long enough for the
 * things people actually send a neighbour — a blocked road, a queue, a leak
 * — and short enough that the wait stays in "this is working" territory
 * rather than "this has hung".
 */
export const MESSAGE_VIDEO_MAX_DURATION_SECONDS = 60;

/**
 * Ceiling on what may be PICKED, before re-encoding.
 *
 * Generous, because this is measured against the camera roll original and
 * the whole point of the encode is that what reaches the bucket is much
 * smaller. A file above this is one the encoder would spend minutes on, so
 * refusing it early is kinder than failing late.
 */
export const MESSAGE_VIDEO_MAX_INPUT_BYTES = 512 * 1024 * 1024;

/**
 * Ceiling on what may be UPLOADED, after re-encoding.
 *
 * A backstop, not the mechanism: duration times bitrate should land well
 * under this, so hitting it means the encode did not do its job and the
 * upload should fail loudly rather than quietly cost money.
 */
export const MESSAGE_VIDEO_MAX_OUTPUT_BYTES = 40 * 1024 * 1024;

/**
 * What a file picker may hand over.
 *
 * `video/quicktime` matters more than it looks: an iPhone records .mov with
 * HEVC by default, so leaving it out would reject the single most common
 * video any of this app's users can produce. Decoding it is the browser's
 * problem — the encode path plays the file through a <video> element rather
 * than demuxing it, precisely so that whatever the platform can play, this
 * can re-encode.
 */
export const MESSAGE_VIDEO_MIME_TYPES = [
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/x-m4v',
] as const;

/** Everything becomes H.264 in MP4 on the way out — the one combination that plays everywhere. */
export const MESSAGE_VIDEO_OUTPUT_MIME = 'video/mp4';

export type MessageVideoProblem = 'type' | 'too_large' | 'empty' | 'too_long' | 'encode_too_large';

export type MessageVideoResult = { ok: true } | { ok: false; problem: MessageVideoProblem };

export function validateMessageVideoFile(file: { type: string; size: number }): MessageVideoResult {
  if (file.size === 0) return { ok: false, problem: 'empty' };
  if (file.size > MESSAGE_VIDEO_MAX_INPUT_BYTES) return { ok: false, problem: 'too_large' };
  // Some pickers hand over an empty type for a file they cannot identify.
  // Treated as "not a video we can take" rather than waved through, since
  // the encoder would fail on it a moment later anyway.
  if (!(MESSAGE_VIDEO_MIME_TYPES as readonly string[]).includes(file.type)) {
    return { ok: false, problem: 'type' };
  }
  return { ok: true };
}

/** Duration is only knowable after the browser has read the file's metadata. */
export function validateMessageVideoDuration(seconds: number): MessageVideoResult {
  if (!Number.isFinite(seconds) || seconds <= 0) return { ok: false, problem: 'empty' };
  if (seconds > MESSAGE_VIDEO_MAX_DURATION_SECONDS) return { ok: false, problem: 'too_long' };
  return { ok: true };
}

export interface VideoSize {
  width: number;
  height: number;
}

/**
 * The encoded frame size: fits inside the ceiling, keeps the aspect ratio,
 * and is rounded to EVEN numbers.
 *
 * The even part is not cosmetic. H.264 in its common profiles encodes in
 * 4:2:0, where chroma planes are half-size in each dimension, so an odd
 * width or height is not representable — `VideoEncoder.configure` rejects
 * it outright on some platforms and silently pads on others. Rounding here
 * means the encoder is never handed a size it has to have an opinion about.
 */
export function messageVideoTargetSize(source: VideoSize): VideoSize {
  const { width, height } = source;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: 0, height: 0 };
  }

  const longest = Math.max(width, height);
  const scale = longest > MESSAGE_VIDEO_MAX_DIMENSION ? MESSAGE_VIDEO_MAX_DIMENSION / longest : 1;

  const even = (n: number) => Math.max(2, Math.round(n * scale / 2) * 2);
  return { width: even(width), height: even(height) };
}

/**
 * Whether a picked file has to be re-encoded at all.
 *
 * Three things make a file already acceptable: it is MP4 (so it plays
 * everywhere without being rewritten), it is within the frame-size ceiling,
 * and it is small enough that re-encoding would cost a generation of quality
 * to save little. All three have to hold — a small 4K file is still 4K, and
 * every viewer would pay to decode it.
 */
export function videoNeedsReencode(file: {
  type: string;
  size: number;
  width: number;
  height: number;
}): boolean {
  if (file.type !== MESSAGE_VIDEO_OUTPUT_MIME) return true;
  if (Math.max(file.width, file.height) > MESSAGE_VIDEO_MAX_DIMENSION) return true;
  return file.size > MESSAGE_VIDEO_MAX_OUTPUT_BYTES / 2;
}
