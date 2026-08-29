"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
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
 * Two steps, not one crowded form:
 *
 *   1. "category"  — tap a big icon. That's the whole step. For a category
 *      with nothing else to add (no subtypes, no description field), tapping
 *      it submits immediately — there is nothing a second step could offer.
 *   2. "details"   — subtype and description, both genuinely optional. One
 *      button, always enabled once nothing's blocking submission: there's no
 *      separate "skip" action, because posting with the fields left blank
 *      *is* skipping them.
 *
 * The pin-drop animation itself lives on the map (`SosoMap.tsx`/`globals.css`)
 * and plays *before* this component ever mounts — `page.tsx` delays opening
 * this until that animation finishes, so the whole sequence reads as one
 * continuous, quick motion: drop, pick, (optionally add a note), done.
 *
 * Everything here is still driven by the server's category configuration
 * rather than a hardcoded list — see the git history on this file for the
 * longer version of that point. That hasn't changed; only the shape of the
 * interaction has.
 */

interface ReportFormProps {
  categories: CategoryConfig[];
  location: Coordinates;
  onCancel: () => void;
  onSubmit: (input: NewPost) => Promise<Pin>;
}

type GeoState = "unknown" | "locating" | "denied" | "timeout" | "unavailable" | "granted" | "unsupported";
type Step = "category" | "details";

export default function ReportForm({ categories, location, onCancel, onSubmit }: ReportFormProps) {
  const [step, setStep] = useState<Step>("category");
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
  //
  // enableHighAccuracy is deliberately true here, unlike the map's own
  // startup geolocation. This value is what gets compared against a 150-500m
  // radius, so a coarse cell-tower fix (often 1km+ off on mobile) can reject
  // a report from someone standing exactly on the spot. A slower, real GPS
  // fix is the right trade for a check that exists specifically to verify
  // presence. Firing this the moment a category is picked — rather than
  // waiting for the details step to mount — means it's often already resolved
  // by the time there's a submit button to press at all.
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
      (err) => {
        if (err.code === err.PERMISSION_DENIED) setGeoState("denied");
        else if (err.code === err.TIMEOUT) setGeoState("timeout");
        else setGeoState("unavailable");
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  }, [category, geoState]);

  const blockedReason = (() => {
    if (!category) return null;
    if (category.requiresProximity) {
      if (geoState === "locating" || geoState === "unknown") return "Finding your location…";
      if (geoState === "denied") return "This needs your location. Allow it in the browser and try again.";
      if (geoState === "timeout") return "Getting a location fix is taking a while — try again, ideally outdoors.";
      if (geoState === "unavailable") return "Couldn't get a location fix. Try again.";
      if (geoState === "unsupported") return "Your browser can't share a location, so this type isn't available here.";
    }
    return null;
  })();

  // Anything other than an outright "no geolocation API at all" is worth
  // retrying — a timeout especially, since a second GPS attempt often
  // succeeds where the first one was still warming up.
  const canRetryLocation = geoState === "denied" || geoState === "timeout" || geoState === "unavailable";

  const canSubmit = Boolean(category && !blockedReason && !busy);

  /** A category with nothing optional to add has no reason to show a second step at all. */
  function hasOptionalDetails(c: CategoryConfig): boolean {
    return c.subtypes.length > 0 || c.allowsBody;
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
      });
    } catch (err) {
      const code = (err as { code?: string }).code as keyof typeof ERROR_MESSAGES_EN | undefined;
      setError(code && code in ERROR_MESSAGES_EN ? ERROR_MESSAGES_EN[code] : ERROR_MESSAGES_EN["soso/unknown"]);
      setBusy(false);
    }
    // No `finally` resetting `busy`: on success the whole component unmounts
    // (the parent closes the composer), so there's nothing left to reset.
  }

  function pickCategory(c: CategoryConfig) {
    setCategoryKey(c.key);
    if (hasOptionalDetails(c)) {
      setStep("details");
    } else {
      // Nothing else this category could ask for — post it right away rather
      // than showing an empty second screen with just a button on it.
      void submit(c, null, "");
    }
  }

  return (
    <div className="quick-composer">
      <button className="composer-close" onClick={onCancel} aria-label="Close pin composer" type="button">
        ×
      </button>

      {step === "category" && (
        <>
          <p className="composer-kicker">✦ Pin dropped</p>
          <h2>What&rsquo;s here?</h2>
          <div className="category-launcher">
            {categories.map((c, i) => {
              const look = lookOf(c.key);
              return (
                <button
                  key={c.key}
                  type="button"
                  className="category-launcher-item"
                  style={{ "--pop-delay": `${i * 55}ms`, "--pin-color": look.color } as CSSProperties}
                  onClick={() => pickCategory(c)}
                >
                  <span className="category-launcher-icon">{look.icon}</span>
                  <span className="category-launcher-label">{c.labelEn}</span>
                </button>
              );
            })}
          </div>
        </>
      )}

      {step === "details" && category && (
        <>
          <button
            type="button"
            className="composer-back"
            onClick={() => {
              setStep("category");
              setCategoryKey(null);
            }}
          >
            ‹ change type
          </button>

          <p className="composer-kicker" style={{ color: lookOf(category.key).color }}>
            {lookOf(category.key).icon} {category.labelEn}
          </p>
          <h2>Add a bit more?</h2>
          <p className="composer-hint">Totally optional — post it as-is if you're in a hurry.</p>

          {category.subtypes.length > 0 && (
            <div className="vibe-picker" style={{ marginBottom: 14 }}>
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
          )}

          {category.allowsBody && (
            <label className="composer-field">
              Description <span>(optional)</span>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={category.bodyMaxLength}
                rows={2}
                placeholder="Keep it factual and free of personal details."
                autoFocus
              />
            </label>
          )}

          <p className="composer-meta">
            Visible for about <strong>{formatDuration(category.defaultTtlSeconds)}</strong>, then it disappears
            on its own.
            {category.locationPrecisionM > 0 &&
              ` Location is rounded to about ${category.locationPrecisionM} m so it can't point at one address.`}
          </p>

          {(error ?? blockedReason) && (
            <div className="form-errors" role="alert">
              <p>{error ?? blockedReason}</p>
              {!error && canRetryLocation && (
                <button type="button" onClick={() => setGeoState("unknown")} className="composer-retry">
                  Try again
                </button>
              )}
            </div>
          )}

          <div className="composer-footer">
            <span>
              📍 {location.latitude.toFixed(3)}, {location.longitude.toFixed(3)}
            </span>
            <button
              className="share-button"
              type="button"
              disabled={!canSubmit}
              onClick={() => void submit(category, subtypeKey, description)}
            >
              {busy ? "Posting…" : "Post it! ✨"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
