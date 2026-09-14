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
  readonly problem: MessageVideoProblem | "undecodable" | "unsupported" | "no_frames" | "load_timeout";

  constructor(problem: MessageVideoProblem | "undecodable" | "unsupported" | "no_frames" | "load_timeout") {
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
    case "load_timeout":
      return "That video took too long to open. Try a shorter clip.";
  }
}

/**
 * Which part of the work is happening, so the composer can say so.
 *
 * Exists because "Compressing video… 0%" was, for a while, the only thing a
 * stuck encode ever showed — `onProgress` is first called from inside the
 * frame loop, so everything before that loop reported nothing at all and
 * every failure before it looked identical. Naming the stage turns a silent
 * wait into a locatable one, for whoever is holding the phone and for
 * whoever reads the bug report.
 */
export type PrepareStage = "reading" | "thumbnail" | "audio" | "encoding";

/**
 * Every await in this file that waits on the PLATFORM rather than on our own
 * arithmetic goes through here.
 *
 * `loadeddata`, `seeked` and `decodeAudioData` are all events that can simply
 * never arrive — a container the decoder gives up on, a seek past what was
 * buffered, a soundtrack in a codec this device only half supports. None of
 * them has a failure event, so the only way to notice is to stop waiting.
 * Before this existed, any of them hung the composer permanently with the
 * send button disabled.
 */
function withTimeout<T>(work: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(onTimeout());
    }, ms);
    work.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Opening the file. Generous: a large clip off a slow phone filesystem is slow to read. */
const LOAD_TIMEOUT_MS = 30_000;

/**
 * Decoding the soundtrack. Bounded much tighter than the load, because
 * failing here costs only the audio — see `decodeAudio`.
 */
const AUDIO_TIMEOUT_MS = 15_000;

/**
 * Above this, the soundtrack is skipped rather than decoded.
 *
 * `decodeAudioData` needs the WHOLE file as one ArrayBuffer, so a 400 MB
 * camera original is 400 MB of JavaScript heap on a device that may have
 * little to spare — and an out-of-memory kill takes the tab, not just the
 * audio. A silent video that sends beats a tab that dies.
 *
 * 256 MB rather than something more cautious, because the cautious number
 * was wrong in a way that mattered: a 60-second 1080p iPhone clip is around
 * 130 MB, so a ceiling below that would have dropped the sound from most
 * real recordings while looking fine on the small test files this was
 * written against. A 4K original still exceeds it, and still loses its
 * audio — which is the honest trade, not a silent one: `soundDropped` below
 * carries it back to the composer.
 */
const AUDIO_MAX_INPUT_BYTES = 256 * 1024 * 1024;

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
  /**
   * True when the clip was sent without its soundtrack.
   *
   * Reached when the file is too large to buffer for decoding, or the
   * platform cannot decode its audio. Surfaced rather than swallowed: a
   * video that arrives silent is a surprise worth one sentence, and the
   * person can still decide to send a shorter clip instead.
   */
  soundDropped: boolean;
}

/** Whether this browser can re-encode at all. */
export function canEncodeVideo(): boolean {
  return typeof globalThis.VideoEncoder === "function" && typeof globalThis.VideoFrame === "function";
}

/**
 * Loads the file into a <video> element far enough that frames can be SEEKED
 * TO AND DRAWN — which on iOS is considerably further than it sounds.
 *
 * WHY THIS IS NOT JUST "WAIT FOR loadeddata"
 * ---------------------------------------------------------------------
 * It was, and that is precisely what broke on iPhone. Two iOS Safari
 * behaviours combine badly here, and neither has an error event:
 *
 *   1. iOS defers loading media DATA until playback is initiated, to save
 *      cellular data. `preload = "auto"` is a hint it is free to ignore, and
 *      does. `loadedmetadata` fires — duration and dimensions arrive — but
 *      `loadeddata` may never fire at all. Waiting on it is waiting forever,
 *      which is the "Opening video…" that never advanced.
 *
 *   2. Even once seeking works, `drawImage(video)` on iOS yields blank
 *      pixels for a video that has never played. The frame is decoded for
 *      display, and nothing has asked it to display anything.
 *
 * So the element is PRIMED: played muted and inline for a moment, then
 * paused and returned to the start. That single play is what makes iOS load
 * the data and warm the decoder, and it is allowed without a user gesture
 * precisely because it is muted and inline.
 *
 * The element also goes into the DOM. A detached media element is the case
 * iOS optimises hardest, and an off-screen 1x1 at near-zero opacity is still
 * "rendered" as far as the decoder is concerned. `prepareVideo`'s own
 * `finally` removes it.
 */
async function loadVideoElement(url: string): Promise<HTMLVideoElement> {
  const el = document.createElement("video");
  el.preload = "auto";
  el.muted = true;
  // Both are required on iOS: without `muted` the play below is refused
  // without a gesture, and without `playsInline` it is handed to the
  // fullscreen system player.
  el.playsInline = true;
  el.crossOrigin = "anonymous";
  el.setAttribute("aria-hidden", "true");
  el.style.cssText =
    "position:fixed;right:0;bottom:0;width:1px;height:1px;opacity:0.01;pointer-events:none;z-index:-1";
  document.body.appendChild(el);
  el.src = url;

  // Metadata is the part iOS WILL give up without playing: duration and
  // dimensions, which is everything needed to validate and size the output.
  await new Promise<void>((resolve, reject) => {
    el.onloadedmetadata = () => resolve();
    el.onerror = () => reject(new VideoEncodeError("undecodable"));
  });

  // The priming play. Deliberately tolerant: a platform that refuses it, or
  // one that needed no priming in the first place, should not fail the
  // encode — the seek loop is what actually has to work, and it reports its
  // own failure through the zero-frame check.
  try {
    await el.play();
    el.pause();
    el.currentTime = 0;
  } catch {
    console.warn("[soso] could not prime video playback; frames may not decode on iOS");
  }

  return el;
}

/**
 * Seeks, and always settles.
 *
 * Two ways `seeked` never arrives, both of which used to hang the composer
 * permanently — `busy` stayed true, so the send button and the file picker
 * stayed disabled with nothing on screen explaining why.
 *
 * The first is a no-op: assigning `currentTime` a value it already holds
 * fires no event at all, because nothing moved. The loop below steps by a
 * frame interval, so any source whose frames are coarser than that can land
 * on the same position twice.
 *
 * The second is a genuine stall — a seek past what has been buffered, or a
 * decoder that gives up on a frame. There is no event for that, so the only
 * way to notice is to stop waiting. Timing out RESOLVES rather than rejects:
 * the element is still sitting on whatever frame it reached, drawing that is
 * better than abandoning the encode, and a systematically stuck seek shows
 * up as the zero-frame check at the end rather than as a hang.
 */
const SEEK_TIMEOUT_MS = 3000;

function seek(el: HTMLVideoElement, time: number): Promise<void> {
  // Below one frame at 120fps: close enough that the browser would treat it
  // as the same position and stay silent.
  if (Math.abs(el.currentTime - time) < 0.0005) return Promise.resolve();

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      el.removeEventListener("seeked", finish);
      resolve();
    };
    const timer = setTimeout(finish, SEEK_TIMEOUT_MS);
    el.addEventListener("seeked", finish);
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
 * Why there is no audio, as well as whether there is any.
 *
 * `dropped` is true only when a soundtrack existed and this code chose not
 * to carry it — too large to buffer, too slow to decode, or in a format the
 * encoder refused. A file that was silent to begin with reports
 * `dropped: false`, so the composer does not announce a loss that never
 * happened.
 */
interface AudioOutcome {
  audio: DecodedAudio | null;
  dropped: boolean;
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
async function decodeAudio(file: Blob): Promise<AudioOutcome> {
  if (typeof globalThis.AudioEncoder !== "function" || typeof globalThis.AudioData !== "function") {
    return { audio: null, dropped: true };
  }

  if (file.size > AUDIO_MAX_INPUT_BYTES) {
    console.warn("[soso] skipping audio: file too large to buffer for decoding", file.size);
    return { audio: null, dropped: true };
  }

  let buffer: AudioBuffer | null;
  try {
    const AudioCtx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AudioCtx();
    // Timed out rather than awaited indefinitely: `decodeAudioData` rejects
    // for a codec it cannot handle, but some platforms simply never settle
    // on a container they half-recognise. Losing the soundtrack is the right
    // way to be wrong here.
    let timedOut = false;
    buffer = await withTimeout(ctx.decodeAudioData(await file.arrayBuffer()), AUDIO_TIMEOUT_MS, () => {
      console.warn("[soso] audio decode timed out; sending without sound");
      timedOut = true;
      return null;
    });
    void ctx.close();
    if (!buffer) return { audio: null, dropped: timedOut };
  } catch {
    // Reached both by a file with NO audio track and by one whose audio this
    // platform cannot decode, and the two are not reliably distinguishable
    // here. Treated as "silent to begin with" rather than "we lost your
    // sound", because the first is far and away the common case — a screen
    // recording, a clip already stripped — and telling someone their audio
    // was dropped when there never was any is worse than saying nothing.
    return { audio: null, dropped: false };
  }
  // Decoded to nothing: a track that exists but is empty. Nothing to lose.
  if (buffer.numberOfChannels === 0 || buffer.length === 0) return { audio: null, dropped: false };

  const config: AudioEncoderConfig = {
    codec: "mp4a.40.2",
    sampleRate: buffer.sampleRate,
    numberOfChannels: Math.min(buffer.numberOfChannels, 2),
    bitrate: MESSAGE_VIDEO_AUDIO_BITRATE,
  };
  const support = await globalThis.AudioEncoder.isConfigSupported(config).catch(() => null);
  // Decoded fine but cannot be re-encoded: there WAS sound and it is being
  // lost, which is exactly the case worth naming.
  if (!support?.supported) return { audio: null, dropped: true };

  return { audio: { buffer, config }, dropped: false };
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
  /**
   * Called as soon as the poster frame exists, which is well before the
   * encode finishes. The composer shows it immediately: a video takes tens
   * of seconds to compress, and a strip with a thumbnail and a percentage is
   * the difference between "this is working" and "this has frozen".
   */
  onPoster?: (poster: Blob) => void,
  /** Which phase is running. See `PrepareStage`. */
  onStage?: (stage: PrepareStage) => void,
): Promise<PreparedVideo> {
  const check = validateMessageVideoFile(file);
  if (!check.ok) throw new VideoEncodeError(check.problem);

  // The DEVELOPER needs this even when the person does not: a clip that will
  // not encode is almost always one whose type or size explains why, and
  // neither is visible anywhere else.
  console.info("[soso] preparing video:", {
    name: file.name,
    type: file.type || "(empty)",
    size: file.size,
  });

  const url = URL.createObjectURL(file);
  let source: HTMLVideoElement | null = null;
  try {
    onStage?.("reading");
    source = await withTimeout(loadVideoElement(url), LOAD_TIMEOUT_MS, () => {
      throw new VideoEncodeError("load_timeout");
    });

    const durationCheck = validateMessageVideoDuration(source.duration);
    if (!durationCheck.ok) throw new VideoEncodeError(durationCheck.problem);

    const natural = { width: source.videoWidth, height: source.videoHeight };
    const target = messageVideoTargetSize(natural);
    if (target.width <= 0 || target.height <= 0) throw new VideoEncodeError("undecodable");

    const durationMs = Math.round(source.duration * 1000);
    onStage?.("thumbnail");
    const poster = await grabPoster(source, target);
    onPoster?.(poster);

    // The fast path. A file that is already an acceptable MP4 is uploaded
    // untouched: re-encoding it would spend the user's battery to make the
    // picture slightly worse.
    if (!videoNeedsReencode({ type: file.type, size: file.size, ...natural })) {
      onProgress?.(1);
      // Untouched, so whatever soundtrack it arrived with is still there.
      return {
        blob: file,
        poster,
        width: natural.width,
        height: natural.height,
        durationMs,
        reencoded: false,
        soundDropped: false,
      };
    }

    if (!canEncodeVideo()) throw new VideoEncodeError("unsupported");

    const encoded = await reencode(source, target, file, onProgress, onStage);
    if (encoded.blob.size > MESSAGE_VIDEO_MAX_OUTPUT_BYTES) {
      throw new VideoEncodeError("encode_too_large");
    }
    return {
      blob: encoded.blob,
      poster,
      width: target.width,
      height: target.height,
      durationMs,
      reencoded: true,
      soundDropped: encoded.soundDropped,
    };
  } finally {
    if (source) {
      source.pause();
      source.removeAttribute("src");
      source.load();
      // Appended by loadVideoElement — see its note on why iOS needs the
      // element in the document at all.
      source.remove();
    }
    URL.revokeObjectURL(url);
  }
}

async function reencode(
  source: HTMLVideoElement,
  target: { width: number; height: number },
  originalFile: Blob,
  onProgress?: (fraction: number) => void,
  onStage?: (stage: PrepareStage) => void,
): Promise<{ blob: Blob; soundDropped: boolean }> {
  // Decoded FIRST, because the muxer below has to be told at construction
  // time whether an audio track exists and at what rate.
  onStage?.("audio");
  const { audio, dropped: soundDropped } = await decodeAudio(originalFile);

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

  // Baseline 3.1 first — the widest-playing H.264 there is, which matters
  // because the result is served as one file to every device. The others are
  // fallbacks rather than preferences: Safari's encoder accepts a narrower
  // set of profile strings than Chrome's, and refusing to encode at all
  // because the most compatible profile was declined would be the wrong way
  // round.
  const CODECS = ["avc1.42001f", "avc1.4d0028", "avc1.640028"];
  let config: VideoEncoderConfig | null = null;
  for (const codec of CODECS) {
    const candidate: VideoEncoderConfig = {
      codec,
      width: target.width,
      height: target.height,
      bitrate: MESSAGE_VIDEO_BITRATE,
      framerate: MESSAGE_VIDEO_MAX_FPS,
    };
    const support = await globalThis.VideoEncoder.isConfigSupported(candidate).catch(() => null);
    if (support?.supported) {
      config = candidate;
      break;
    }
  }
  if (!config) throw new VideoEncodeError("unsupported");

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
  onStage?.("encoding");
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

  return {
    blob: new Blob([(muxer.target as ArrayBufferTarget).buffer], { type: MESSAGE_VIDEO_OUTPUT_MIME }),
    soundDropped,
  };
}
