"use client";

import { ArrayBufferTarget, Muxer } from "mp4-muxer";
import {
  MESSAGE_VIDEO_AUDIO_BITRATE,
  MESSAGE_VIDEO_BITRATE,
  MESSAGE_VIDEO_MAX_DURATION_SECONDS,
  MESSAGE_VIDEO_MAX_FPS,
  MESSAGE_VIDEO_MAX_OUTPUT_BYTES,
  MESSAGE_VIDEO_OUTPUT_MIME,
  messageVideoTargetSize,
  validateMessageVideoDuration,
  validateMessageVideoFile,
  videoNeedsReencode,
  type MessageVideoProblem,
} from "soso-core";

/**
 * Re-encoding a picked video on the device, before it is ever uploaded.
 *
 * This is the piece that makes storing video affordable at all: there is no
 * server-side transcoding and no Cloudflare Stream, so if a 400 MB camera
 * roll original is not shrunk here, it is shrunk nowhere. See
 * `packages/core/src/domain/message-video.ts` for the numbers and why they
 * are what they are.
 *
 * THE SHAPE OF THIS, AND THE ONE CLEVER BIT
 * ---------------------------------------------------------------------
 * WebCodecs gives you an encoder and a decoder and nothing else — no
 * demuxer, no muxer. The usual way to build a transcoder is therefore
 * mp4box.js to pull encoded chunks out of the source, `VideoDecoder` to turn
 * them into frames, `VideoEncoder` to turn them back, and a muxer to write
 * the result. That pipeline is large, and it dies on the first iPhone video
 * it meets, because HEVC decoding through `VideoDecoder` is patchy.
 *
 * So the demuxer and decoder are skipped entirely. Frames are pulled out of
 * a plain `<video>` element — which the platform already knows how to decode,
 * HEVC and all — by SEEKING to each timestamp and drawing the result. The
 * browser is the decoder. That is what makes this a few hundred lines instead
 * of a subsystem, and what makes it work on the files people actually have.
 *
 * WHY SEEKING RATHER THAN PLAYING
 * ---------------------------------------------------------------------
 * The obvious version of this plays the clip and takes frames off
 * `requestVideoFrameCallback`. That was tried and abandoned, for two reasons
 * found by measuring rather than by reasoning.
 *
 * The first is that rVFC hands over PRESENTED frames, so it is bounded by
 * the display: pushing `playbackRate` up to go faster than real time makes
 * the browser skip frames, and the output becomes a slideshow. There is no
 * setting at which it is both fast and complete.
 *
 * The second is worse. rVFC fires as part of the rendering steps, so it
 * delivers nothing at all when the page is not being painted — a
 * backgrounded tab, a locked phone, or an embedded/offscreen compositor. In
 * testing it produced zero frames even with the element attached and
 * playing at 1x. An encoder that silently yields an empty video whenever the
 * user looks away is not an encoder.
 *
 * Seeking has neither problem. It does not depend on playback, on the
 * compositor, or on the element being in the document, and it is frame-exact
 * because this code chooses the timestamps. Measured at roughly 7ms per
 * frame, which is several times faster than real time — a 60-second clip at
 * 30fps is around fifteen seconds of work, reported through `onProgress`.
 *
 * AUDIO TAKES A DIFFERENT ROUTE
 * ---------------------------------------------------------------------
 * `AudioContext.decodeAudioData` decodes the whole soundtrack from the
 * original file in one call, container and codec handled by the platform
 * again. That is far simpler than pulling audio chunks out in step with the
 * video, and it is why the two tracks are encoded independently and only
 * meet in the muxer.
 *
 * WHAT HAPPENS WHEN THIS IS NOT AVAILABLE
 * ---------------------------------------------------------------------
 * `VideoEncoder` is absent on older Safari and on Firefox. Rather than
 * refuse to send video there, `prepareVideo` falls back to uploading the
 * original when it is already small enough and in MP4 — which is exactly
 * what `videoNeedsReencode` is for — and reports an honest problem when it
 * is not. A browser that cannot encode can still receive and play.
 */

export class VideoEncodeError extends Error {
  readonly problem: MessageVideoProblem | "undecodable" | "unsupported" | "no_frames";

  constructor(problem: MessageVideoProblem | "undecodable" | "unsupported" | "no_frames") {
    super(problem);
    this.name = "VideoEncodeError";
    this.problem = problem;
  }
}

export function videoProblemMessage(problem: VideoEncodeError["problem"]): string {
  switch (problem) {
    case "type":
      return "That file isn't a video we can send.";
    case "too_large":
      return "That video is too large to prepare on this device.";
    case "empty":
      return "That file is empty.";
    case "too_long":
      return "Videos can be up to 60 seconds.";
    case "encode_too_large":
      return "That video is still too large after compressing. Try a shorter clip.";
    case "undecodable":
      return "That video couldn't be opened on this device.";
    case "unsupported":
      return "This browser can't compress video. Try a smaller clip, or use Chrome or Safari.";
    case "no_frames":
      return "Compressing stopped — keep this tab open and try again.";
  }
}

export interface PreparedVideo {
  /** The MP4 to upload — the re-encoded result, or the original when it was already fine. */
  blob: Blob;
  /** A JPEG of the first frame. Stored alongside, so a feed never shows a black rectangle. */
  poster: Blob;
  width: number;
  height: number;
  durationMs: number;
  /** False when the original was passed through untouched. Useful for logging, not for the UI. */
  reencoded: boolean;
}

/** Whether this browser can re-encode at all. */
export function canEncodeVideo(): boolean {
  return typeof globalThis.VideoEncoder === "function" && typeof globalThis.VideoFrame === "function";
}

/**
 * Loads the file into a <video> element far enough to know its shape.
 *
 * `preload="metadata"` is not enough for `requestVideoFrameCallback` later,
 * so this waits for `loadeddata` — the point at which a first frame actually
 * exists and can be drawn.
 */
function loadVideoElement(url: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const el = document.createElement("video");
    el.preload = "auto";
    el.muted = true;
    // Required on iOS or `play()` is refused outside a fullscreen player,
    // which would stop the frame pump before it started.
    el.playsInline = true;
    el.crossOrigin = "anonymous";
    el.onloadeddata = () => resolve(el);
    el.onerror = () => reject(new VideoEncodeError("undecodable"));
    el.src = url;
  });
}

function seek(el: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      el.removeEventListener("seeked", done);
      resolve();
    };
    el.addEventListener("seeked", done);
    el.onerror = () => reject(new VideoEncodeError("undecodable"));
    el.currentTime = time;
  });
}

/**
 * A still from near the start, as JPEG.
 *
 * Taken at 0.1s rather than 0, because the very first frame of a phone
 * recording is often black or mid-exposure — the sensor has not settled.
 */
async function grabPoster(el: HTMLVideoElement, size: { width: number; height: number }): Promise<Blob> {
  await seek(el, Math.min(0.1, (el.duration || 1) / 2));
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new VideoEncodeError("undecodable");
  ctx.drawImage(el, 0, 0, size.width, size.height);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new VideoEncodeError("undecodable"))),
      "image/jpeg",
      0.82,
    );
  });
}

interface DecodedAudio {
  buffer: AudioBuffer;
  config: AudioEncoderConfig;
}

/**
 * Decodes the original's soundtrack, and confirms this platform can re-encode
 * it, WITHOUT writing anything yet.
 *
 * Split from the encode below for a structural reason rather than a stylistic
 * one: mp4-muxer needs its tracks declared when the muxer is constructed, so
 * whether there is audio at all — and at what sample rate — has to be known
 * before that point. An earlier version called a combined `encodeAudio` after
 * building a video-only muxer, which meant every audio chunk was handed to a
 * container with nowhere to put it.
 *
 * Returns null when the file has no audio track, when the platform cannot
 * decode it, or when there is no `AudioEncoder` — a video that arrives silent
 * is a far better outcome than one that fails to send.
 */
async function decodeAudio(file: Blob): Promise<DecodedAudio | null> {
  if (typeof globalThis.AudioEncoder !== "function" || typeof globalThis.AudioData !== "function") {
    return null;
  }

  let buffer: AudioBuffer;
  try {
    const AudioCtx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AudioCtx();
    buffer = await ctx.decodeAudioData(await file.arrayBuffer());
    void ctx.close();
  } catch {
    return null;
  }
  if (buffer.numberOfChannels === 0 || buffer.length === 0) return null;

  const config: AudioEncoderConfig = {
    codec: "mp4a.40.2",
    sampleRate: buffer.sampleRate,
    numberOfChannels: Math.min(buffer.numberOfChannels, 2),
    bitrate: MESSAGE_VIDEO_AUDIO_BITRATE,
  };
  const support = await globalThis.AudioEncoder.isConfigSupported(config).catch(() => null);
  if (!support?.supported) return null;

  return { buffer, config };
}

/** Feeds an already-decoded soundtrack through AAC into a muxer that expects it. */
async function encodeAudio(audio: DecodedAudio, muxer: Muxer<ArrayBufferTarget>): Promise<void> {
  const { buffer: decoded, config } = audio;
  const encoder = new globalThis.AudioEncoder({
    output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
    error: () => {
      // Swallowed deliberately: an audio failure mid-encode should cost the
      // soundtrack, not the video.
    },
  });
  encoder.configure(config);

  // Interleaved f32, which is what AudioData expects for 'f32'. Fed in
  // ~1 second slices so a long clip does not build one enormous buffer.
  const channels = config.numberOfChannels!;
  const rate = decoded.sampleRate;
  const chunkFrames = rate;
  for (let offset = 0; offset < decoded.length; offset += chunkFrames) {
    const frames = Math.min(chunkFrames, decoded.length - offset);
    const interleaved = new Float32Array(frames * channels);
    for (let c = 0; c < channels; c += 1) {
      const source = decoded.getChannelData(Math.min(c, decoded.numberOfChannels - 1));
      for (let i = 0; i < frames; i += 1) interleaved[i * channels + c] = source[offset + i]!;
    }
    const data = new globalThis.AudioData({
      format: "f32",
      sampleRate: rate,
      numberOfFrames: frames,
      numberOfChannels: channels,
      timestamp: Math.round((offset / rate) * 1_000_000),
      data: interleaved,
    });
    encoder.encode(data);
    data.close();
  }

  await encoder.flush();
  encoder.close();
}

/**
 * Validates, measures, posters and (when needed) re-encodes a picked video.
 *
 * `onProgress` receives 0..1 through the encode. It is the only honest
 * feedback available — the work is bounded by playback, so there is a real
 * fraction to report rather than a spinner standing in for one.
 */
export async function prepareVideo(
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<PreparedVideo> {
  const check = validateMessageVideoFile(file);
  if (!check.ok) throw new VideoEncodeError(check.problem);

  const url = URL.createObjectURL(file);
  let source: HTMLVideoElement | null = null;
  try {
    source = await loadVideoElement(url);

    const durationCheck = validateMessageVideoDuration(source.duration);
    if (!durationCheck.ok) throw new VideoEncodeError(durationCheck.problem);

    const natural = { width: source.videoWidth, height: source.videoHeight };
    const target = messageVideoTargetSize(natural);
    if (target.width <= 0 || target.height <= 0) throw new VideoEncodeError("undecodable");

    const durationMs = Math.round(source.duration * 1000);
    const poster = await grabPoster(source, target);

    // The fast path. A file that is already an acceptable MP4 is uploaded
    // untouched: re-encoding it would spend the user's battery to make the
    // picture slightly worse.
    if (!videoNeedsReencode({ type: file.type, size: file.size, ...natural })) {
      onProgress?.(1);
      return { blob: file, poster, width: natural.width, height: natural.height, durationMs, reencoded: false };
    }

    if (!canEncodeVideo()) throw new VideoEncodeError("unsupported");

    const blob = await reencode(source, target, file, onProgress);
    if (blob.size > MESSAGE_VIDEO_MAX_OUTPUT_BYTES) {
      throw new VideoEncodeError("encode_too_large");
    }
    return { blob, poster, width: target.width, height: target.height, durationMs, reencoded: true };
  } finally {
    if (source) {
      source.pause();
      source.removeAttribute("src");
      source.load();
    }
    URL.revokeObjectURL(url);
  }
}

async function reencode(
  source: HTMLVideoElement,
  target: { width: number; height: number },
  originalFile: Blob,
  onProgress?: (fraction: number) => void,
): Promise<Blob> {
  // Decoded FIRST, because the muxer below has to be told at construction
  // time whether an audio track exists and at what rate.
  const audio = await decodeAudio(originalFile);

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: "avc", width: target.width, height: target.height },
    ...(audio
      ? {
          audio: {
            codec: "aac" as const,
            sampleRate: audio.config.sampleRate!,
            numberOfChannels: audio.config.numberOfChannels!,
          },
        }
      : {}),
    // Written last, in memory, so the moov atom lands at the front of the
    // file. Without it a progressive player has to fetch the tail before it
    // can start — which over a presigned URL means a visible stall on every
    // first play.
    fastStart: "in-memory",
    firstTimestampBehavior: "offset",
  });

  if (audio) await encodeAudio(audio, muxer);

  const config: VideoEncoderConfig = {
    // Baseline profile, level 3.1 — the widest-playing H.264 there is, which
    // matters because the result is served as one file to every device.
    codec: "avc1.42001f",
    width: target.width,
    height: target.height,
    bitrate: MESSAGE_VIDEO_BITRATE,
    framerate: MESSAGE_VIDEO_MAX_FPS,
  };
  const support = await globalThis.VideoEncoder.isConfigSupported(config).catch(() => null);
  if (!support?.supported) throw new VideoEncodeError("unsupported");

  const encoder = new globalThis.VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: () => {
      throw new VideoEncodeError("undecodable");
    },
  });
  encoder.configure(config);

  const canvas = document.createElement("canvas");
  canvas.width = target.width;
  canvas.height = target.height;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new VideoEncodeError("undecodable");

  // The output frame rate. Sampling at a fixed cadence rather than following
  // the source's own is what caps a 60fps recording at 30: the extra frames
  // would steal bits from the ones that are kept, at a bitrate chosen for 30.
  const step = 1 / MESSAGE_VIDEO_MAX_FPS;
  const duration = source.duration;
  // A hard ceiling on the loop. Duration is already validated, so this is a
  // guard against a container that misreports it rather than an expected
  // path — an unbounded seek loop would hang the tab.
  const maxFrames = MESSAGE_VIDEO_MAX_FPS * MESSAGE_VIDEO_MAX_DURATION_SECONDS + 2;
  let frames = 0;

  for (let t = 0; t < duration - 0.001 && frames < maxFrames; t += step) {
    await seek(source, t);
    ctx.drawImage(source, 0, 0, target.width, target.height);
    const frame = new globalThis.VideoFrame(canvas, {
      timestamp: Math.round(t * 1_000_000),
      duration: Math.round(step * 1_000_000),
    });
    // A keyframe every two seconds: enough for seeking without spending a
    // large share of the bitrate on them.
    encoder.encode(frame, { keyFrame: frames % (MESSAGE_VIDEO_MAX_FPS * 2) === 0 });
    frame.close();
    frames += 1;
    onProgress?.(Math.min(0.99, t / Math.max(duration, 0.001)));

    // Yields between frames so the encoder's own queue drains and the tab
    // stays responsive. Without it a long clip is one uninterrupted task and
    // the progress it is reporting never paints.
    if (frames % 8 === 0) await new Promise((r) => setTimeout(r, 0));
  }

  await encoder.flush();
  encoder.close();

  // A clip that produced no frames at all cannot be muxed: the container
  // needs the first chunk's `decoderConfig` to describe the track, so
  // finalizing here would throw a TypeError from inside mp4-muxer instead of
  // saying what went wrong.
  //
  // It is reachable, and not only in testing. `requestVideoFrameCallback`
  // fires as part of the rendering steps, so a browser that has stopped
  // rendering the page — backgrounded tab, phone screen locked mid-encode —
  // delivers nothing while `play()` still reports success. That is a real
  // thing a person can do to this, and it deserves a sentence rather than a
  // stack trace.
  if (frames === 0) throw new VideoEncodeError("no_frames");

  muxer.finalize();
  onProgress?.(1);

  return new Blob([(muxer.target as ArrayBufferTarget).buffer], { type: MESSAGE_VIDEO_OUTPUT_MIME });
}
