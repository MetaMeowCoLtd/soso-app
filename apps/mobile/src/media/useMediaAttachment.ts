import * as ImagePicker from "expo-image-picker";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  ERROR_MESSAGES_EN,
  validateMessageImageFile,
  validateMessageVideoFile,
  type MessageImageProblem,
  type MessageMedia,
  type SosoGateway,
} from "../core";
import { prepareMessageImage } from "./imagePipeline";
import { prepareVideo, VideoEncodeError, videoProblemMessage } from "./videoPipeline";

class MessageImageError extends Error {
  readonly problem: MessageImageProblem;
  constructor(problem: MessageImageProblem) {
    super(problem);
    this.problem = problem;
  }
}

function messageImageMessage(problem: MessageImageProblem): string {
  switch (problem) {
    case "type":
      return "That file isn't an image we can send.";
    case "too_large":
      return "That image is too large.";
    case "empty":
      return "That file is empty.";
  }
}

/**
 * Ported from apps/web/src/web/useMediaAttachment.ts. The state shape and
 * the "upload starts on pick, not on send" policy are unchanged — see that
 * file's own module comment for why.
 *
 * WHAT'S DIFFERENT: there is no `<input type="file">` for this to receive
 * a file FROM. RN has no file-input-plus-hidden-button pattern at all, so
 * `pick()` takes no argument and IS the picker — it opens
 * `expo-image-picker`'s own OS-native library sheet itself, and the
 * composer's "add a photo" button just calls it. One picker for both kinds,
 * same as web's combined `accept` list: `mediaTypes: ["images", "videos"]`
 * is that list's RN equivalent, and which pipeline runs is still decided
 * from what was actually picked (`asset.type`), never from which button
 * was pressed.
 */
export interface MediaAttachment {
  media: MessageMedia | null;
  previewUri: string | null;
  busy: boolean;
  statusText: string | null;
  error: string | null;
  pick: () => void;
  clear: () => void;
}

export function useMediaAttachment(
  gateway: SosoGateway,
  scope: { kind: "room" } | { kind: "dm"; threadId: string } | { kind: "post" },
): MediaAttachment {
  const [media, setMedia] = useState<MessageMedia | null>(null);
  const [previewUri, setPreviewUri] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pickSeq = useRef(0);
  const scopeKey = scope.kind === "dm" ? `dm:${scope.threadId}` : scope.kind;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  const clear = useCallback(() => {
    pickSeq.current += 1;
    setPreviewUri(null);
    setMedia(null);
    setBusy(false);
    setProgress(null);
    setError(null);
  }, []);

  useEffect(() => clear, [scopeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = useCallback(() => {
    void (async () => {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        setError("Photos access is needed to attach a file.");
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images", "videos"], quality: 1 });
      if (result.canceled || !result.assets?.[0]) return;
      const asset = result.assets[0]!;

      const seq = ++pickSeq.current;
      setMedia(null);
      setPreviewUri(null);
      setError(null);
      setBusy(true);

      try {
        if (asset.type === "video") {
          const check = validateMessageVideoFile({ type: asset.mimeType ?? "video/mp4", size: asset.fileSize ?? 0 });
          if (!check.ok) throw new VideoEncodeError(check.problem);

          setPreviewUri(asset.uri);
          const prepared = await prepareVideo(
            asset.uri,
            asset.width,
            asset.height,
            asset.duration ?? 0,
            asset.mimeType ?? "video/mp4",
            asset.fileSize ?? 0,
            (fraction) => {
              if (seq === pickSeq.current) setProgress(fraction);
            },
          );
          if (seq !== pickSeq.current) return;

          const posterPath = await gateway.uploadMessageMedia(prepared.poster, scopeRef.current, "image");
          if (seq !== pickSeq.current) return;
          const path = await gateway.uploadMessageMedia(prepared.blob, scopeRef.current, "video");
          if (seq !== pickSeq.current) return;

          setMedia({ kind: "video", path, width: prepared.width, height: prepared.height, posterPath, durationMs: prepared.durationMs });
          return;
        }

        const check = validateMessageImageFile({ type: asset.mimeType ?? "image/jpeg", size: asset.fileSize ?? 0 });
        if (!check.ok) throw new MessageImageError(check.problem);

        const prepared = await prepareMessageImage(asset.uri, asset.width, asset.height);
        if (seq !== pickSeq.current) return;
        setPreviewUri(prepared.previewUri);

        const path = await gateway.uploadMessageMedia(prepared.blob, scopeRef.current, "image");
        if (seq !== pickSeq.current) return;

        setMedia({ kind: "image", path, width: prepared.width, height: prepared.height, posterPath: null, durationMs: null });
      } catch (err) {
        if (seq !== pickSeq.current) return;
        console.warn("[soso] media attach failed:", err);
        const code = (err as { code?: string }).code;
        setError(
          err instanceof VideoEncodeError
            ? videoProblemMessage(err.problem)
            : err instanceof MessageImageError
              ? messageImageMessage(err.problem)
              : code && code in ERROR_MESSAGES_EN
                ? ERROR_MESSAGES_EN[code as keyof typeof ERROR_MESSAGES_EN]
                : "Couldn't attach that file. Try again.",
        );
        setPreviewUri(null);
      } finally {
        if (seq === pickSeq.current) {
          setBusy(false);
          setProgress(null);
        }
      }
    })();
  }, [gateway]);

  const statusText = error
    ? null
    : busy
      ? progress !== null
        ? `Compressing video… ${Math.round(progress * 100)}%`
        : "Uploading…"
      : media !== null
        ? "Ready to send"
        : null;

  return { media, previewUri, busy, statusText, error, pick, clear };
}
