import * as ImagePicker from "expo-image-picker";
import { useCallback, useState } from "react";

import { validateCoverFile, type CoverCrop, type SosoGateway } from "../core";
import type { DecodedAvatarImage } from "./AvatarCropper";
import { renderCoverCrop } from "./imagePipeline";

/**
 * The cover-photo counterpart of useAvatarPhoto.ts — same shape, same
 * reasoning for not merging the two (see that file's own note, and
 * cover.ts's module comment on why avatar/cover stay parallel rather than
 * one generalized pipeline). Cover photos reuse the avatar pipeline's
 * STORAGE (`uploadAvatar`/same bucket — see cover.ts's own comment on why)
 * but their own crop geometry.
 */
export interface CoverPhoto {
  cropping: DecodedAvatarImage | null;
  pendingUri: string | null;
  rendering: boolean;
  error: string | null;
  pick: () => void;
  applyCrop: (crop: CoverCrop) => void;
  closeCropper: () => void;
  clear: () => void;
  upload: () => Promise<string | null>;
}

export function useCoverPhoto(gateway: SosoGateway): CoverPhoto {
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
        setError("Photos access is needed to change your cover photo.");
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 1 });
      if (result.canceled || !result.assets?.[0]) return;
      const asset = result.assets[0]!;

      const check = validateCoverFile({ type: asset.mimeType ?? "image/jpeg", size: asset.fileSize ?? 0 });
      if (!check.ok) {
        setError(check.problem === "too_large" ? "That image is too large. Pick one under 12 MB." : "Pick a JPEG, PNG or WebP image.");
        return;
      }

      setError(null);
      setCropping({ uri: asset.uri, width: asset.width, height: asset.height });
    })();
  }, []);

  const applyCrop = useCallback(
    (crop: CoverCrop) => {
      if (!cropping) return;
      setRendering(true);
      void (async () => {
        try {
          const blob = await renderCoverCrop(cropping.uri, crop);
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
    return gateway.uploadAvatar(pendingBlob);
  }, [gateway, pendingBlob]);

  return { cropping, pendingUri, rendering, error, pick, applyCrop, closeCropper, clear, upload };
}
