import * as ImagePicker from "expo-image-picker";
import { useCallback, useState } from "react";

import { validateAvatarFile, type SquareCrop, type SosoGateway } from "../core";
import type { DecodedAvatarImage } from "./AvatarCropper";
import { renderAvatarCrop } from "./imagePipeline";

/**
 * Ported from apps/web/src/web/useGroupPhoto.ts's shape — this is that
 * same "pick, crop, hold a rendered blob until something uploads it"
 * pattern, split into its own hook because a profile avatar's caller
 * (ProfileSettings) has a completely different save flow (a form-level
 * Save button, not upload-the-moment-a-crop-is-confirmed) from a group's.
 *
 * NO SEPARATE "DECODE" STEP, UNLIKE apps/web/src/web/avatarImage.ts's
 * `decodeAvatarFile`. That function exists to hand the DOM cropper a
 * `CanvasImageSource` plus oriented width/height — work `createImageBitmap`
 * has to do explicitly on web. `expo-image-picker`'s result already
 * reports a picked asset's oriented width/height, and `AvatarCropper` here
 * displays the file by its own URI directly (a plain `<Image>`, not a
 * canvas), so there is nothing left for a decode step to produce.
 */
export interface AvatarPhoto {
  cropping: DecodedAvatarImage | null;
  /** The cropped, re-encoded result, held until something calls `upload()`. */
  pendingUri: string | null;
  rendering: boolean;
  error: string | null;
  pick: () => void;
  applyCrop: (crop: SquareCrop) => void;
  closeCropper: () => void;
  clear: () => void;
  upload: () => Promise<string | null>;
}

export function useAvatarPhoto(gateway: SosoGateway): AvatarPhoto {
  const [cropping, setCropping] = useState<DecodedAvatarImage | null>(null);
  const [pendingBlob, setPendingBlob] = useState<Blob | null>(null);
  const [pendingUri, setPendingUri] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clear = useCallback(() => {
    setCropping(null);
    setPendingBlob(null);
    setPendingUri(null);
    setRendering(false);
    setError(null);
  }, []);

  const pick = useCallback(() => {
    void (async () => {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        setError("Photos access is needed to change your photo.");
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 1 });
      if (result.canceled || !result.assets?.[0]) return;
      const asset = result.assets[0]!;

      const check = validateAvatarFile({ type: asset.mimeType ?? "image/jpeg", size: asset.fileSize ?? 0 });
      if (!check.ok) {
        setError(check.problem === "too_large" ? "That image is too large. Pick one under 12 MB." : "Pick a JPEG, PNG or WebP image.");
        return;
      }

      setError(null);
      setCropping({ uri: asset.uri, width: asset.width, height: asset.height });
    })();
  }, []);

  const applyCrop = useCallback(
    (crop: SquareCrop) => {
      if (!cropping) return;
      setRendering(true);
      void (async () => {
        try {
          const blob = await renderAvatarCrop(cropping.uri, crop);
          setPendingBlob(blob);
          setPendingUri(cropping.uri);
          setCropping(null);
        } catch {
          setError("Couldn't process that image. Try another one.");
        } finally {
          setRendering(false);
        }
      })();
    },
    [cropping],
  );

  const closeCropper = useCallback(() => setCropping(null), []);

  const upload = useCallback(async (): Promise<string | null> => {
    if (!pendingBlob) return null;
    const path = await gateway.uploadAvatar(pendingBlob);
    return path;
  }, [gateway, pendingBlob]);

  return { cropping, pendingUri, rendering, error, pick, applyCrop, closeCropper, clear, upload };
}
