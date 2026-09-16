import * as Location from "expo-location";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";

import {
  ERROR_MESSAGES_EN,
  formatDuration,
  type CategoryConfig,
  type NewPost,
  type Pin,
  type PostAudience,
  type SosoGateway,
} from "../core";
import { useMediaAttachment } from "../media/useMediaAttachment";
import { lookOf } from "../theme/categories";
import { Icon, ICONS } from "../theme/Icon";
import { COLORS } from "../theme/tokens";
import { AppText } from "../ui/AppText";
import { Button } from "../ui/Button";
import { toLngLat, type Coordinates } from "./region";

/**
 * Ported from apps/web/src/web/ReportForm.tsx. Same two-step design: pick a
 * category (submits immediately if it has nothing else to add), then an
 * optional details step. As of C10, a category that `allowsMedia` offers
 * the same attach control the chat composer does, via the same
 * `useMediaAttachment` hook (scope `{kind: "post"}`).
 *
 * THE PROXIMITY GATE
 * -----------------------------------------------------------------------
 * `navigator.geolocation.getCurrentPosition({ enableHighAccuracy: true,
 * timeout: 15000, maximumAge: 0 })` becomes `expo-location`'s
 * `getCurrentPositionAsync({ accuracy: Location.Accuracy.High })`, wrapped
 * in a manual 15s timeout — expo-location has no built-in `timeout` option
 * the way the web Geolocation API does. `maximumAge: 0` has no direct
 * expo-location equivalent either; `getCurrentPositionAsync` always
 * requests a fresh fix rather than serving a cached one, so there's
 * nothing to disable. Same reasoning as web for why this is high-accuracy
 * specifically, unlike the map's own passive location dot: this value gets
 * compared against a 150-500m proximity radius, and a coarse fix can
 * reject a report from someone standing exactly on the spot.
 *
 * This is the one screen in the whole port that genuinely needs a physical
 * device to verify — the simulator's simulated location is either exactly
 * right or exactly wrong depending on what's configured, never a realistic
 * "how much does a real GPS fix drift" test.
 */

type GeoState = "unknown" | "locating" | "denied" | "timeout" | "unavailable" | "granted" | "unsupported";
type Step = "category" | "details";

class LocationTimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new LocationTimeoutError("timed out")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

interface ReportFormProps {
  gateway: SosoGateway;
  categories: CategoryConfig[];
  location: Coordinates;
  onCancel: () => void;
  onSubmit: (input: NewPost) => Promise<Pin>;
}

const AUDIENCE_OPTIONS: { key: PostAudience; label: string; hint: string }[] = [
  { key: "public", label: "Everyone", hint: "Anyone using SoSo here" },
  { key: "friends", label: "Friends", hint: "People you both follow" },
  { key: "close_friends", label: "Close friends", hint: "Friends you marked close" },
];

export default function ReportForm({ gateway, categories, location, onCancel, onSubmit }: ReportFormProps) {
  const [step, setStep] = useState<Step>("category");
  const [categoryKey, setCategoryKey] = useState<string | null>(null);
  const [subtypeKey, setSubtypeKey] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const attachment = useMediaAttachment(gateway, { kind: "post" });
  // Defaults to public. A private default would be a surprising place to
  // put a safety decision: someone reporting a hazard expects it to be seen.
  const [audience, setAudience] = useState<PostAudience>("public");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [geoState, setGeoState] = useState<GeoState>("unknown");
  const [device, setDevice] = useState<Coordinates | null>(null);

  // This composer starts from a dropped pin, so it can only honestly offer
  // categories that keep one — see apps/web's identical filter and its
  // note on why a location-optional category ("thought") would look like
  // dropping a pin and watching it never appear.
  const placeableCategories = useMemo(() => categories.filter((c) => c.requiresLocation), [categories]);

  const category = useMemo(
    () => placeableCategories.find((c) => c.key === categoryKey) ?? null,
    [placeableCategories, categoryKey],
  );

  // Subtypes are scoped to a category server-side, so switching category
  // invalidates whatever was picked.
  useEffect(() => setSubtypeKey(null), [categoryKey]);

  // Only request location when a selected category actually needs it —
  // same reasoning as web: asking upfront for every visit is the kind of
  // permission prompt that gets a reflexive "block."
  useEffect(() => {
    if (!category?.requiresProximity || geoState !== "unknown") return;

    let cancelled = false;
    (async () => {
      setGeoState("locating");
      const servicesEnabled = await Location.hasServicesEnabledAsync();
      if (cancelled) return;
      if (!servicesEnabled) {
        setGeoState("unsupported");
        return;
      }
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (cancelled) return;
      if (status !== "granted") {
        setGeoState("denied");
        return;
      }
      try {
        const position = await withTimeout(
          Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
          15000,
        );
        if (cancelled) return;
        setDevice({ latitude: position.coords.latitude, longitude: position.coords.longitude });
        setGeoState("granted");
      } catch (err) {
        if (cancelled) return;
        setGeoState(err instanceof LocationTimeoutError ? "timeout" : "unavailable");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [category, geoState]);

  const blockedReason = (() => {
    if (!category) return null;
    if (category.requiresProximity) {
      if (geoState === "locating" || geoState === "unknown") return "Finding your location…";
      if (geoState === "denied") return "This needs your location. Allow it in Settings and try again.";
      if (geoState === "timeout") return "Getting a location fix is taking a while — try again, ideally outdoors.";
      if (geoState === "unavailable") return "Couldn't get a location fix. Try again.";
      if (geoState === "unsupported") return "Location services are off, so this type isn't available here.";
    }
    return null;
  })();

  // Anything other than an outright "no location services at all" is worth
  // retrying — a timeout especially, since a second GPS attempt often
  // succeeds where the first one was still warming up.
  const canRetryLocation = geoState === "denied" || geoState === "timeout" || geoState === "unavailable";

  const canSubmit = Boolean(category && !blockedReason && !busy && !attachment.busy);

  /** A category with nothing optional to add has no reason to show a second step at all. */
  function hasOptionalDetails(c: CategoryConfig): boolean {
    return c.subtypes.length > 0 || c.allowsBody || c.allowsMedia;
  }

  async function submit(chosenCategory: CategoryConfig, chosenSubtype: string | null, body: string) {
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        category: chosenCategory.key,
        subtype: chosenSubtype,
        body: chosenCategory.allowsBody ? body.trim() || null : null,
        at: toLngLat(location),
        device: device ? toLngLat(device) : null,
        audience,
        media: attachment.media
          ? {
              kind: attachment.media.kind,
              objectKey: attachment.media.path,
              width: attachment.media.width,
              height: attachment.media.height,
              posterKey: attachment.media.posterPath,
              durationMs: attachment.media.durationMs,
            }
          : null,
      });
    } catch (err) {
      const code = (err as { code?: string }).code as keyof typeof ERROR_MESSAGES_EN | undefined;
      setError(code && code in ERROR_MESSAGES_EN ? ERROR_MESSAGES_EN[code] : ERROR_MESSAGES_EN["soso/unknown"]);
      setBusy(false);
    }
    // No `finally` resetting `busy`: on success the parent closes the
    // composer, so there's nothing left to reset — same as web.
  }

  function pickCategory(c: CategoryConfig) {
    setCategoryKey(c.key);
    if (hasOptionalDetails(c)) {
      setStep("details");
    } else {
      void submit(c, null, "");
    }
  }

  return (
    <View style={styles.card}>
      <Pressable onPress={onCancel} style={styles.closeButton} accessibilityLabel="Close pin composer">
        <Icon src={ICONS.close} size={16} color={COLORS.muted} />
      </Pressable>

      {step === "category" && (
        <ScrollView>
          <View style={styles.kickerRow}>
            <Icon src={ICONS.sparkle} size={13} color={COLORS.muted} />
            <AppText style={styles.kicker}>Pin dropped</AppText>
          </View>
          <AppText style={styles.heading}>What's here?</AppText>
          <View style={styles.categoryGrid}>
            {placeableCategories.map((c) => {
              const look = lookOf(c.key);
              return (
                <Pressable key={c.key} style={styles.categoryItem} onPress={() => pickCategory(c)}>
                  <View style={[styles.categoryIcon, { backgroundColor: look.color }]}>
                    <Icon src={look.icon} size={22} color="#ffffff" />
                  </View>
                  <AppText style={styles.categoryLabel}>{c.labelEn}</AppText>
                </Pressable>
              );
            })}
          </View>
        </ScrollView>
      )}

      {step === "details" && category && (
        <ScrollView>
          <Pressable
            style={styles.backRow}
            onPress={() => {
              setStep("category");
              setCategoryKey(null);
            }}
          >
            <Icon src={ICONS.chevronLeft} size={13} color={COLORS.muted} />
            <AppText style={styles.backText}>change type</AppText>
          </Pressable>

          <View style={styles.kickerRow}>
            <Icon src={lookOf(category.key).icon} size={15} color={lookOf(category.key).color} />
            <AppText style={[styles.kicker, { color: lookOf(category.key).color }]}>{category.labelEn}</AppText>
          </View>
          <AppText style={styles.heading}>Add a bit more?</AppText>
          <AppText style={styles.hint}>
            {category.key === "board"
              ? "Optional name — tapping the pin opens a drawing canvas."
              : "Totally optional — post it as-is if you're in a hurry."}
          </AppText>

          {category.subtypes.length > 0 && (
            <View style={styles.subtypeRow}>
              {category.subtypes.map((s) => (
                <Pressable
                  key={s.key}
                  style={[styles.subtypeOption, subtypeKey === s.key && styles.subtypeOptionSelected]}
                  onPress={() => setSubtypeKey(s.key)}
                >
                  <AppText style={subtypeKey === s.key ? styles.subtypeLabelSelected : styles.subtypeLabel}>
                    {s.labelEn}
                  </AppText>
                </Pressable>
              ))}
            </View>
          )}

          {category.allowsBody && (
            <View style={styles.field}>
              <AppText style={styles.fieldLabel}>Description (optional)</AppText>
              <TextInput
                style={styles.textArea}
                value={description}
                onChangeText={setDescription}
                maxLength={category.bodyMaxLength}
                multiline
                numberOfLines={2}
                placeholder={
                  category.key === "board"
                    ? "A name for this board, if you want one."
                    : "Keep it factual and free of personal details."
                }
                placeholderTextColor={COLORS.muted}
              />
            </View>
          )}

          {category.allowsMedia && (
            <View style={styles.field}>
              <AppText style={styles.fieldLabel}>Photo or video (optional)</AppText>
              {attachment.previewUri ? (
                <View style={styles.attachmentPreview}>
                  <Image source={{ uri: attachment.previewUri }} style={styles.attachmentThumb} />
                  {attachment.busy && <ActivityIndicator size="small" style={styles.attachmentSpinner} />}
                  <AppText style={styles.attachmentStatus}>{attachment.error ?? attachment.statusText}</AppText>
                  <Pressable onPress={attachment.clear} accessibilityLabel="Remove attachment" style={styles.attachmentRemove}>
                    <Icon src={ICONS.close} size={11} color={COLORS.muted} />
                  </Pressable>
                </View>
              ) : (
                <Pressable style={styles.attachButton} onPress={attachment.pick} disabled={busy}>
                  <Icon src={ICONS.image} size={16} color={COLORS.ink} />
                  <AppText style={styles.attachButtonText}>Add a photo</AppText>
                </Pressable>
              )}
              {attachment.error && !attachment.previewUri && <AppText style={styles.errorText}>{attachment.error}</AppText>}
            </View>
          )}

          <View style={styles.audiencePicker}>
            <AppText style={styles.fieldLabel}>Visible to</AppText>
            <View style={styles.audienceOptions}>
              {AUDIENCE_OPTIONS.map((option) => (
                <Pressable
                  key={option.key}
                  style={[styles.audienceOption, audience === option.key && styles.audienceOptionSelected]}
                  onPress={() => setAudience(option.key)}
                >
                  <AppText style={audience === option.key ? styles.audienceLabelSelected : styles.audienceLabel}>
                    {option.label}
                  </AppText>
                </Pressable>
              ))}
            </View>
          </View>

          <AppText style={styles.metaText}>
            Visible for about {formatDuration(category.defaultTtlSeconds)}
            {category.key === "board" ? ", and drawing on it keeps it around." : ", then it disappears on its own."}
            {category.locationPrecisionM > 0 &&
              ` Location is rounded to about ${category.locationPrecisionM} m so it can't point at one address.`}
          </AppText>

          {(error ?? blockedReason) && (
            <View style={styles.errorBox}>
              <AppText style={styles.errorText}>{error ?? blockedReason}</AppText>
              {!error && canRetryLocation && (
                <Button label="Try again" variant="secondary" onPress={() => setGeoState("unknown")} style={styles.retryButton} />
              )}
            </View>
          )}

          <View style={styles.footer}>
            <View style={styles.footerLocation}>
              <Icon src={ICONS.place} size={13} color={COLORS.muted} />
              <AppText style={styles.footerLocationText}>
                {location.latitude.toFixed(3)}, {location.longitude.toFixed(3)}
              </AppText>
            </View>
            <Button
              label={busy ? "Posting…" : "Post it!"}
              disabled={!canSubmit}
              onPress={() => void submit(category, subtypeKey, description)}
            />
          </View>
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: COLORS.glass, borderRadius: 16, padding: 16, maxHeight: "70%" },
  closeButton: { alignSelf: "flex-end", padding: 6 },
  kickerRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  kicker: { fontSize: 12, color: COLORS.muted, fontWeight: "600" },
  heading: { fontSize: 20, fontWeight: "700", marginTop: 4, marginBottom: 12 },
  hint: { fontSize: 12, color: COLORS.muted, marginBottom: 12 },
  categoryGrid: { flexDirection: "row", flexWrap: "wrap", gap: 14 },
  categoryItem: { width: 78, alignItems: "center", gap: 6 },
  categoryIcon: { width: 48, height: 48, borderRadius: 24, alignItems: "center", justifyContent: "center" },
  categoryLabel: { fontSize: 11, textAlign: "center" },
  backRow: { flexDirection: "row", alignItems: "center", gap: 4, marginBottom: 12 },
  backText: { fontSize: 12, color: COLORS.muted },
  subtypeRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 14 },
  subtypeOption: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: COLORS.line },
  subtypeOptionSelected: { backgroundColor: COLORS.teal, borderColor: COLORS.teal },
  subtypeLabel: { fontSize: 13, color: COLORS.ink },
  subtypeLabelSelected: { fontSize: 13, color: "#ffffff", fontWeight: "600" },
  field: { marginBottom: 14 },
  fieldLabel: { fontSize: 12, fontWeight: "600", marginBottom: 6 },
  textArea: {
    borderWidth: 1,
    borderColor: COLORS.line,
    borderRadius: 10,
    padding: 10,
    fontSize: 14,
    color: COLORS.ink,
    minHeight: 60,
    textAlignVertical: "top",
  },
  attachButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderColor: COLORS.line,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    alignSelf: "flex-start",
  },
  attachButtonText: { fontSize: 13, fontWeight: "600" },
  attachmentPreview: { flexDirection: "row", alignItems: "center", gap: 8 },
  attachmentThumb: { width: 44, height: 44, borderRadius: 8 },
  attachmentSpinner: { position: "absolute", top: 12, left: 12 },
  attachmentStatus: { flex: 1, fontSize: 12, color: COLORS.muted },
  attachmentRemove: { padding: 6 },
  audiencePicker: { marginBottom: 12 },
  audienceOptions: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  audienceOption: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: COLORS.line },
  audienceOptionSelected: { backgroundColor: COLORS.teal, borderColor: COLORS.teal },
  audienceLabel: { fontSize: 13, color: COLORS.ink },
  audienceLabelSelected: { fontSize: 13, color: "#ffffff", fontWeight: "600" },
  metaText: { fontSize: 12, color: COLORS.muted, marginBottom: 12, lineHeight: 17 },
  errorBox: { marginBottom: 12 },
  errorText: { fontSize: 12, color: COLORS.hot },
  retryButton: { marginTop: 6, alignSelf: "flex-start" },
  footer: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  footerLocation: { flexDirection: "row", alignItems: "center", gap: 4 },
  footerLocationText: { fontSize: 12, color: COLORS.muted },
});
