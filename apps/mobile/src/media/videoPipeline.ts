/**
 * Replaces apps/web/src/web/videoEncode.ts — 700 lines down to well under
 * 100, which the project's own plan called the largest simplification in
 * this whole port, and this is why: that file exists to build a transcoder
 * OUT OF WEB APIS THAT DON'T PROVIDE ONE (WebCodecs has an encoder and a
 * decoder and nothing else — no demuxer, no muxer — so the web version
 * pulls frames out of a `<video>` element by seeking and redraws them
 * through `VideoEncoder`, muxes with `mp4-muxer`, and decodes audio
 * separately through `AudioContext`). None of that exists to work around
 * here: `react-native-compressor` calls the PLATFORM'S OWN media
 * transcoder (`AVAssetExportSession` on iOS, `MediaCodec` on Android)
 * directly, which already knows how to open a file, keep audio in sync,
 * and write a real MP4 — it is the muxer, the demuxer and the encoder
 * these 700 lines existed to build.
 *
 * `soundDropped` — the one WEB-SPECIFIC hazard in `PreparedVideo`'s
 * contract — genuinely does not exist on this platform. It exists on web
 * because `decodeAudioData` needs the WHOLE file buffered as one
 * `ArrayBuffer` in JS heap, which a large original could blow through; a
 * native transcoder streams the file and never holds it all in memory at
 * once. Kept in the return type anyway (always `false`) so callers ported
 * from the web composer — which do check it — don't need a second code
 * path for a platform where the problem never occurs.
 */

import * as VideoThumbnails from "expo-video-thumbnails";
import { Video } from "react-native-compressor";

import {
  MESSAGE_VIDEO_BITRATE,
  messageVideoTargetSize,
  MESSAGE_VIDEO_MAX_OUTPUT_BYTES,
  videoNeedsReencode,
  type MessageVideoProblem,
} from "../core";
import { uriToBlob } from "./blob";
import { resizeImageFile } from "./imagePipeline";

export class VideoEncodeError extends Error {
  readonly problem: MessageVideoProblem | "undecodable" | "too_large_after_compress";

  constructor(problem: VideoEncodeError["problem"]) {
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
    case "too_large_after_compress":
      return "That video is still too large after compressing. Try a shorter clip.";
    case "undecodable":
      return "That video couldn't be opened on this device.";
  }
}

export interface PreparedVideo {
  blob: Blob;
  poster: Blob;
  width: number;
  height: number;
  durationMs: number;
  reencoded: boolean;
  /** Always false on this platform — see the module comment. */
  soundDropped: boolean;
}

/**
 * `originalWidth`/`originalHeight`/`durationMs` come from the picker's own
 * asset metadata (`expo-image-picker`'s result already reports a video
 * asset's dimensions and duration) — nothing here has to open the file
 * itself just to measure it, which is most of what `videoEncode.ts`'s own
 * `loadVideoElement` existed for.
 */
export async function prepareVideo(
  uri: string,
  originalWidth: number,
  originalHeight: number,
  durationMs: number,
  mimeType: string,
  fileSize: number,
  onProgress: (fraction: number) => void,
): Promise<PreparedVideo> {
  const target = messageVideoTargetSize({ width: originalWidth, height: originalHeight });

  // The same "already fine, don't bother" check the web version makes —
  // pure core logic, unchanged.
  const needsReencode = videoNeedsReencode({
    type: mimeType,
    size: fileSize,
    width: originalWidth,
    height: originalHeight,
  });

  let outputUri = uri;
  let reencoded = false;
  if (needsReencode) {
    outputUri = await Video.compress(
      uri,
      { compressionMethod: "manual", bitrate: MESSAGE_VIDEO_BITRATE, maxSize: Math.max(target.width, target.height) },
      onProgress,
    );
    reencoded = true;
  } else {
    onProgress(1);
  }

  const outputBlob = await uriToBlob(outputUri);
  if (outputBlob.size > MESSAGE_VIDEO_MAX_OUTPUT_BYTES) {
    throw new VideoEncodeError("too_large_after_compress");
  }

  // The first frame, resized to the same target the video itself was —
  // matches the web version's "a JPEG of the first frame, stored
  // alongside, so a feed never shows a black rectangle".
  const thumb = await VideoThumbnails.getThumbnailAsync(uri, { time: 0 });
  const poster = await resizeImageFile(thumb.uri, thumb.width, thumb.height, Math.max(target.width, target.height));
  const posterBlob = await uriToBlob(poster.uri);

  return {
    blob: outputBlob,
    poster: posterBlob,
    width: reencoded ? target.width : originalWidth,
    height: reencoded ? target.height : originalHeight,
    durationMs,
    reencoded,
    soundDropped: false,
  };
}
