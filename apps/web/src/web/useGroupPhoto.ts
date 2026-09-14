"use client";

import { useCallback, useEffect, useState } from "react";
import { ERROR_MESSAGES_EN, type SosoGateway, type SquareCrop } from "soso-core";
import {
  AvatarImageError,
  avatarImageMessage,
  decodeAvatarFile,
  renderAvatarCrop,
  type DecodedAvatar,
} from "./avatarImage";

/**
 * Picking a group's photo: decode, crop, hold, upload.
 *
 * The same four steps `ProfileSettings` performs for a profile picture, hoisted
 * into a hook because two surfaces now need them — naming a new group, and
 * changing an existing one's picture — and a third copy of "decode, open the
 * cropper, render the crop, release the bitmap on unmount" is three places for
 * an object URL to leak.
 *
 * IT UPLOADS THROUGH `uploadAvatar`, into the caller's OWN folder in the
 * public avatars bucket, which is the whole reason group photos needed no new
 * storage infrastructure. Migration 0047's `dm_threads_photo_shape` check
 * accepts any `<uuid>/<token>.jpg`, not only the group's own — see its comment
 * for what that costs (an object outlives the uploader's membership) and why
 * that was preferred to a second bucket and a server-side copy.
 *
 * UPLOADING IS DELIBERATELY NOT PART OF PICKING. `upload()` is called by the
 * screen at save time, so a photo chosen and then abandoned leaves nothing
 * behind — the same split `ProfileSettings` makes, and the same one
 * `useMediaAttachment` makes for a message.
 */
export interface GroupPhoto {
  /** The decoded file currently being positioned, or null when the cropper is closed. */
  cropping: DecodedAvatar | null;
  /** An object URL for the cropped-but-not-uploaded image, or null. */
  previewUrl: string | null;
  /** True while a crop is being encoded — keeps the cropper's buttons from firing twice. */
  rendering: boolean;
  /** True while the file is being decoded, before the cropper can open. */
  preparing: boolean;
  error: string | null;
  pick: (file: File | null | undefined) => void;
  applyCrop: (crop: SquareCrop) => void;
  closeCropper: () => void;
  /** Discards the pending photo. Does not touch anything already saved. */
  clear: () => void;
  /**
   * Uploads the pending photo and returns its object path, or null when
   * nothing was picked. Throws on failure, so the caller can keep the screen
   * open rather than saving a group with a photo that never arrived.
   */
  upload: () => Promise<string | null>;
}

export function useGroupPhoto(gateway: SosoGateway): GroupPhoto {
  const [cropping, setCropping] = useState<DecodedAvatar | null>(null);
  const [pending, setPending] = useState<{ blob: Blob; previewUrl: string } | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Both handles are owned by this hook, so both are released here rather than
  // relying on whichever screen happened to unmount to remember.
  useEffect(() => () => cropping?.release(), [cropping]);
  useEffect(
    () => () => {
      if (pending) URL.revokeObjectURL(pending.previewUrl);
    },
    [pending],
  );

  const closeCropper = useCallback(() => {
    setCropping((current) => {
      current?.release();
      return null;
    });
    setRendering(false);
  }, []);

  const pick = useCallback((file: File | null | undefined) => {
    if (!file) return;
    setPreparing(true);
    setError(null);
    void (async () => {
      try {
        // Decode only. Which part of it becomes the photo is the cropper's
        // question, not one to answer on the person's behalf here.
        setCropping(await decodeAvatarFile(file));
      } catch (err) {
        setError(
          err instanceof AvatarImageError
            ? avatarImageMessage(err.problem)
            : ERROR_MESSAGES_EN["soso/unknown"],
        );
      } finally {
        setPreparing(false);
      }
    })();
  }, []);

  const applyCrop = useCallback(
    (crop: SquareCrop) => {
      if (!cropping) return;
      setRendering(true);
      setError(null);
      void (async () => {
        try {
          const blob = await renderAvatarCrop(cropping, crop);
          setPending((previous) => {
            // Re-picking replaces the earlier choice, so the URL behind it has
            // nothing left pointing at it.
            if (previous) URL.revokeObjectURL(previous.previewUrl);
            return { blob, previewUrl: URL.createObjectURL(blob) };
          });
          closeCropper();
        } catch (err) {
          setError(
            err instanceof AvatarImageError
              ? avatarImageMessage(err.problem)
              : ERROR_MESSAGES_EN["soso/unknown"],
          );
          // Leaves the cropper open: the framing is still on screen and still
          // valid, so a retry costs a tap rather than repositioning from
          // scratch. ProfileSettings makes the same choice.
          setRendering(false);
        }
      })();
    },
    [cropping, closeCropper],
  );

  const clear = useCallback(() => {
    setPending((previous) => {
      if (previous) URL.revokeObjectURL(previous.previewUrl);
      return null;
    });
    setError(null);
  }, []);

  const upload = useCallback(async () => {
    if (!pending) return null;
    return gateway.uploadAvatar(pending.blob);
  }, [gateway, pending]);

  return {
    cropping,
    previewUrl: pending?.previewUrl ?? null,
    rendering,
    preparing,
    error,
    pick,
    applyCrop,
    closeCropper,
    clear,
    upload,
  };
}
