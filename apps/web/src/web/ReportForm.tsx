"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ERROR_MESSAGES_EN,
  formatDuration,
  type CategoryConfig,
  type NewPost,
  type Pin,
} from "soso-core";
import { lookOf } from "./theme";
import { toLngLat, type Coordinates } from "./region";

/**
 * The report composer.
 *
 * Everything here is driven by the server's category configuration rather than
 * a hardcoded list: which categories exist, whether a category has subtypes,
 * whether it takes a description at all and how long, its default lifetime,
 * and whether posting it requires the poster's device to actually be nearby.
 *
 * The client renders what it is told and validates none of it beyond basic UI
 * affordances (disable submit until a category is picked). `create_post`
 * re-checks every one of these rules server-side — this is the "server-side
 * validation" piece: the old prototype's `validateReport()` duplicated length
 * and range checks on the client, and that duplication is exactly what a
 * config-table-plus-SECURITY-DEFINER-function architecture is meant to remove.
 * A category the server disables, or a limit the server tightens, takes effect
 * on next page load with no client change.
 */

interface ReportFormProps {
  categories: CategoryConfig[];
  location: Coordinates;
  onCancel: () => void;
  onSubmit: (input: NewPost) => Promise<Pin>;
}

type GeoState = "unknown" | "locating" | "granted" | "denied" | "unsupported";

export default function ReportForm({ categories, location, onCancel, onSubmit }: ReportFormProps) {
  const [categoryKey, setCategoryKey] = useState<string | null>(null);
  const [subtypeKey, setSubtypeKey] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [geoState, setGeoState] = useState<GeoState>("unknown");
  const [device, setDevice] = useState<Coordinates | null>(null);

  const category = useMemo(
    () => categories.find((c) => c.key === categoryKey) ?? null,
    [categories, categoryKey],
  );

  // Subtypes are scoped to a category server-side, so switching category
  // invalidates whatever was picked — a stale subtype would be rejected by
  // create_post rather than silently reassigned.
  useEffect(() => setSubtypeKey(null), [categoryKey]);

  // Only ask for the browser's location when a selected category actually
  // needs it. Asking upfront for every visit is the kind of permission prompt
  // that gets a reflexive "block" before the user has any reason to trust it.
  useEffect(() => {
    if (!category?.requiresProximity || geoState !== "unknown") return;
    if (!("geolocation" in navigator)) {
      setGeoState("unsupported");
      return;
    }
    setGeoState("locating");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setDevice({ latitude: pos.coords.latitude, longitude: pos.coords.longitude });
        setGeoState("granted");
      },
      () => setGeoState("denied"),
      { enableHighAccuracy: false, timeout: 8000 },
    );
  }, [category, geoState]);

  const blockedReason = (() => {
    if (!category) return null;
    if (category.requiresProximity) {
      if (geoState === "locating" || geoState === "unknown") return "Finding your location…";
      if (geoState === "denied") return "This needs your location. Allow it in the browser and try again.";
      if (geoState === "unsupported") return "Your browser can't share a location, so this type isn't available here.";
    }
    return null;
  })();

  const canSubmit = Boolean(category && !blockedReason && !busy);

  async function submit() {
    if (!category) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        category: category.key,
        subtype: subtypeKey,
        body: category.allowsBody ? description.trim() || null : null,
        at: toLngLat(location),
        device: device ? toLngLat(device) : null,
      });
      setDescription("");
    } catch (err) {
      const code = (err as { code?: string }).code as keyof typeof ERROR_MESSAGES_EN | undefined;
      setError(code && code in ERROR_MESSAGES_EN ? ERROR_MESSAGES_EN[code] : ERROR_MESSAGES_EN["soso/unknown"]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="quick-composer"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      noValidate
    >
      <button className="composer-close" onClick={onCancel} aria-label="Close pin composer" type="button">
        ×
      </button>
      <p className="composer-kicker">✦ Pin dropped</p>
      <h2>What&rsquo;s here?</h2>
      <p className="composer-hint">Pick a type, add a note if it helps, and share it with people nearby.</p>

      <fieldset>
        <legend>Choose a pin</legend>
        <div className="vibe-picker">
          {categories.map((c) => {
            const look = lookOf(c.key);
            return (
              <label className={`vibe-option ${categoryKey === c.key ? "selected" : ""}`} key={c.key}>
                <input
                  type="radio"
                  name="category"
                  value={c.key}
                  checked={categoryKey === c.key}
                  onChange={() => setCategoryKey(c.key)}
                />
                <span className="vibe-emoji" style={{ backgroundColor: look.color }}>
                  {look.icon}
                </span>
                <span>{c.labelEn}</span>
              </label>
            );
          })}
        </div>
      </fieldset>

      {category && category.subtypes.length > 0 && (
        <fieldset>
          <legend>Type</legend>
          <div className="vibe-picker">
            {category.subtypes.map((s) => (
              <label className={`vibe-option ${subtypeKey === s.key ? "selected" : ""}`} key={s.key}>
                <input
                  type="radio"
                  name="subtype"
                  value={s.key}
                  checked={subtypeKey === s.key}
                  onChange={() => setSubtypeKey(s.key)}
                />
                <span>{s.labelEn}</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {category?.allowsBody && (
        <label className="composer-field">
          Add context <span>(optional, but helpful)</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={category.bodyMaxLength}
            rows={2}
            placeholder="Keep it factual and free of personal details."
          />
        </label>
      )}

      {category && (
        <p className="composer-meta">
          Visible for about <strong>{formatDuration(category.defaultTtlSeconds)}</strong>, then it disappears
          on its own.
          {category.locationPrecisionM > 0 &&
            ` Location is rounded to about ${category.locationPrecisionM} m so it can't point at one address.`}
        </p>
      )}

      {(error ?? blockedReason) && (
        <div className="form-errors" role="alert">
          <p>{error ?? blockedReason}</p>
        </div>
      )}

      <div className="composer-footer">
        <span>
          📍 {location.latitude.toFixed(3)}, {location.longitude.toFixed(3)}
        </span>
        <button className="share-button" type="submit" disabled={!canSubmit}>
          {busy ? "Posting…" : "Drop it! ✨"}
        </button>
      </div>
    </form>
  );
}
