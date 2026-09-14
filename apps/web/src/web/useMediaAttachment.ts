"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ERROR_MESSAGES_EN, type MessageMedia, type SosoGateway } from "soso-core";
import { MessageImageError, messageImageMessage, prepareMessageImage } from "./messageImage";
import {
  prepareVideo,
  VideoEncodeError,
  videoProblemMessage,
  type PrepareStage,
} from "./videoEncode";

/**
 * The "there is an image on this message I am about to send" state.
 *
 * Shared by the room composer and the DM composer rather than written twice,
 * for the same reason `MessageActionSheet` and `useSwipeToReply` are shared:
 * the two surfaces are supposed to behave identically, and the way to make
 * that true is for them to run the same code, not for someone to remember to
 * change both. (See the DM/room parity note in ChatPanel's own comment.)
 *
 * WHEN THE UPLOAD ACTUALLY HAPPENS
 * ---------------------------------------------------------------------
 * On pick, not on send. Encoding a phone photo takes a moment and uploading
 * it takes longer, and doing both after the send button is pressed would
 * make sending an image feel broken in exactly the way sending text does
 * not. Picking starts the work immediately, the composer shows a thumbnail
 * with a progress state, and by the time a caption has been typed the bytes
 * are usually already in the bucket — at which point `send` is the same
 * instant RPC it is for text.
 *
 * The cost of that choice, stated because it is a real one: an image picked
 * and then abandoned leaves an object in the bucket that no message
 * references. Migration 0040's header records that there is no sweeper for
 * those yet.
 */

export interface MediaAttachment {
  /** Non-null once the bytes are in the bucket and the message can carry it. */
  media: MessageMedia | null;
  /** Object URL for the local preview, available from the moment of picking. */
  previewUrl: string | null;
  /** True while encoding or uploading. Send is blocked on it. */
  busy: boolean;
  /**
   * One line describing what is happening right now, or null when idle.
   *
   * Computed here rather than in each composer, which is a real
   * simplification and not just tidying: the same three-branch ternary was
   * written out in four places, and when video was added only two of them
   * learned about it. There is one sentence per state and one place to
   * change it.
   */
  statusText: string | null;
  /** One honest sentence, or null. */
  error: string | null;
  /** Hand a picked file straight from an <input type="file">. */
  pick: (file: File) => void;
  /** Drops the attachment and releases its preview. */
  clear: () => void;
}

export function useMediaAttachment(
  gateway: SosoGateway,
  scope: { kind: "room" } | { kind: "dm"; threadId: string } | { kind: "post" },
): MediaAttachment {
  const [media, setMedia] = useState<MessageMedia | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [stage, setStage] = useState<PrepareStage | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Identifies the CURRENT pick, so a slow upload for a photo that has since
  // been replaced or cleared cannot land and overwrite the newer one.
  const pickSeq = useRef(0);
  // Held in a ref as well as state so `clear` and unmount can revoke it
  // without either depending on the render that set it.
  const previewRef = useRef<string | null>(null);

  const releasePreview = useCallback(() => {
    if (previewRef.current) {
      // An object URL is a live handle into the document; dropping the last
      // reference without revoking it keeps the whole decoded image alive
      // for the life of the page.
      URL.revokeObjectURL(previewRef.current);
      previewRef.current = null;
    }
  }, []);

  useEffect(() => releasePreview, [releasePreview]);

  const clear = useCallback(() => {
    pickSeq.current += 1;
    releasePreview();
    setPreviewUrl(null);
    setMedia(null);
    setBusy(false);
    setProgress(null);
    setStage(null);
    setError(null);
  }, [releasePreview]);

  const scopeKey = scope.kind === "dm" ? `dm:${scope.threadId}` : scope.kind;

  const pick = useCallback(
    (file: File) => {
      const seq = ++pickSeq.current;
      releasePreview();
      setMedia(null);
      setPreviewUrl(null);
      setError(null);
      setBusy(true);

      void (async () => {
        try {
          // Which pipeline this is comes from the file, not from which button
          // was pressed: one picker accepts both, so a clip chosen from a
          // combined picker has to reach the video path.
          if (file.type.startsWith("video/")) {
            setProgress(0);
            const prepared = await prepareVideo(
              file,
              (fraction) => {
                // Guarded, or a superseded encode would keep driving the bar
                // for a pick nobody is waiting on any more.
                if (seq === pickSeq.current) setProgress(fraction);
              },
              (poster) => {
                // Shown the moment it exists, which is before the encode —
                // the same still the recipient will see before pressing
                // play. Waiting until the end meant the composer rendered
                // nothing at all for the whole compression, with sending
                // disabled and no way to cancel.
                if (seq !== pickSeq.current) return;
                const url = URL.createObjectURL(poster);
                previewRef.current = url;
                setPreviewUrl(url);
              },
              (nextStage) => {
                if (seq === pickSeq.current) setStage(nextStage);
              },
            );
            if (seq !== pickSeq.current) return;

            // Two objects, uploaded in order. The poster goes first and is
            // cheap; if the clip then fails, the orphan left behind is a
            // thumbnail rather than tens of megabytes.
            const posterPath = await gateway.uploadMessageMedia(prepared.poster, scope, "image");
            if (seq !== pickSeq.current) return;
            const path = await gateway.uploadMessageMedia(prepared.blob, scope, "video");
            if (seq !== pickSeq.current) return;

            setMedia({
              kind: "video",
              path,
              width: prepared.width,
              height: prepared.height,
              posterPath,
              durationMs: prepared.durationMs,
            });
            return;
          }

          const prepared = await prepareMessageImage(file);
          if (seq !== pickSeq.current) {
            // Superseded while encoding. Release what we just made rather
            // than leaking it, and leave the newer pick's state alone.
            URL.revokeObjectURL(prepared.previewUrl);
            return;
          }

          // Shown as soon as it exists, before the upload finishes — the
          // person sees their photo immediately and the spinner is about
          // the sending, not about whether the pick worked.
          previewRef.current = prepared.previewUrl;
          setPreviewUrl(prepared.previewUrl);

          const path = await gateway.uploadMessageMedia(prepared.blob, scope, "image");
          if (seq !== pickSeq.current) return;

          setMedia({
            kind: "image",
            path,
            width: prepared.width,
            height: prepared.height,
            posterPath: null,
            durationMs: null,
          });
        } catch (err) {
          if (seq !== pickSeq.current) return;
          // The user-facing copy stays short, but the DEVELOPER needs the
          // real cause: this branch is reached by anything that is not one
          // of `messageImage.ts`'s own validation errors — a canvas
          // `drawImage` refusing an image the browser decoded but cannot
          // draw, a failed presign, a rejected PUT — and they are not
          // distinguishable on screen. iOS in particular hands over files
          // this code cannot reproduce on a desktop, so the file's own
          // reported type and size go in the log too; they are the first
          // thing worth knowing and the app never otherwise reveals them.
          console.warn("[soso] image attach failed:", {
            name: file.name,
            type: file.type || "(empty)",
            size: file.size,
            error: err,
          });
          // A SosoError carries a code the app already has honest wording
          // for, and collapsing it into "try again" was actively harmful:
          // `soso/r2_not_configured` means the bucket or the Edge Function
          // is not set up, which no amount of trying again will fix, and
          // the one message that could have said so was being discarded.
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
          releasePreview();
          setPreviewUrl(null);
        } finally {
          if (seq === pickSeq.current) {
            setBusy(false);
            setProgress(null);
            setStage(null);
          }
        }
      })();
    },
    // `scope` is an object literal at every call site, so it is a new
    // reference on every render; keying on its contents instead is what
    // stops this callback being rebuilt constantly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [gateway, scopeKey, releasePreview],
  );

  /**
   * Each stage gets its own sentence. "Compressing video… 0%" used to be the
   * only thing shown for everything before the frame loop, so opening the
   * file, grabbing a thumbnail and decoding the soundtrack were all
   * indistinguishable from an encode that had stalled at zero.
   */
  const statusText = error
    ? null
    : stage === "reading"
      ? "Opening video…"
      : stage === "thumbnail"
        ? "Reading video…"
        : stage === "audio"
          ? "Preparing audio…"
          : stage === "encoding" && progress !== null
            ? `Compressing video… ${Math.round(progress * 100)}%`
            : busy
              ? "Uploading…"
              : media !== null
                ? "Ready to send"
                : null;

  return { media, previewUrl, busy, statusText, error, pick, clear };
}
