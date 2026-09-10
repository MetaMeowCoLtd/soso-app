"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MessageImage, SosoGateway } from "soso-core";
import { MessageImageError, messageImageMessage, prepareMessageImage } from "./messageImage";

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

export interface ImageAttachment {
  /** Non-null once the bytes are in the bucket and the message can carry it. */
  image: MessageImage | null;
  /** Object URL for the local preview, available from the moment of picking. */
  previewUrl: string | null;
  /** True while encoding or uploading. Send is blocked on it. */
  busy: boolean;
  /** One honest sentence, or null. */
  error: string | null;
  /** Hand a picked file straight from an <input type="file">. */
  pick: (file: File) => void;
  /** Drops the attachment and releases its preview. */
  clear: () => void;
}

export function useImageAttachment(
  gateway: SosoGateway,
  scope: { kind: "room" } | { kind: "dm"; threadId: string },
): ImageAttachment {
  const [image, setImage] = useState<MessageImage | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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
    setImage(null);
    setBusy(false);
    setError(null);
  }, [releasePreview]);

  const scopeKey = scope.kind === "room" ? "room" : `dm:${scope.threadId}`;

  const pick = useCallback(
    (file: File) => {
      const seq = ++pickSeq.current;
      releasePreview();
      setImage(null);
      setPreviewUrl(null);
      setError(null);
      setBusy(true);

      void (async () => {
        try {
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

          const path = await gateway.uploadMessageImage(prepared.blob, scope);
          if (seq !== pickSeq.current) return;

          setImage({ path, width: prepared.width, height: prepared.height });
        } catch (err) {
          if (seq !== pickSeq.current) return;
          setError(
            err instanceof MessageImageError
              ? messageImageMessage(err.problem)
              : "Couldn't attach that image. Try again.",
          );
          releasePreview();
          setPreviewUrl(null);
        } finally {
          if (seq === pickSeq.current) setBusy(false);
        }
      })();
    },
    // `scope` is an object literal at every call site, so it is a new
    // reference on every render; keying on its contents instead is what
    // stops this callback being rebuilt constantly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [gateway, scopeKey, releasePreview],
  );

  return { image, previewUrl, busy, error, pick, clear };
}
