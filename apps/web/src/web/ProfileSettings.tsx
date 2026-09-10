"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AVATAR_MIME_TYPES,
  bioRemaining,
  BIO_MAX,
  DISPLAY_NAME_MAX,
  ERROR_MESSAGES_EN,
  isOwnAvatarPath,
  validateBio,
  validateDisplayName,
  type AvatarPath,
  type MyProfile,
  type SosoGateway,
  type SquareCrop,
} from "soso-core";
import { Avatar } from "./Avatar";
import AvatarCropper from "./AvatarCropper";
import {
  AvatarImageError,
  avatarImageMessage,
  decodeAvatarFile,
  renderAvatarCrop,
  type DecodedAvatar,
} from "./avatarImage";
import { Icon, ICONS } from "./Icon";

/**
 * Edit your own profile: display name, bio, and notification settings.
 *
 * A full-screen surface, not a panel — the same shape as DmThreadView and
 * ThoughtThread (see their `position:fixed; z-index:20` in globals.css),
 * because editing your identity is a task you commit to and leave, not a
 * thing you glance at over the map.
 *
 * WHAT IT DELIBERATELY IS AND ISN'T, VERSUS THE APPS IT LEARNS FROM
 * ---------------------------------------------------------------------
 * Instagram, Threads and LINE all pile a settings screen high with rows —
 * links, banners, professional-account switches, "show that your profile is
 * verified", music. Most of those are surface area this app does not have.
 * This screen does the three things asked for and stops: name, bio,
 * notifications. The restraint is the design — a settings page that only
 * shows what you can actually change is faster to use than one you have to
 * scan past.
 *
 * HOW THE AVATAR TILE WORKS
 * ---------------------------------------------------------------------
 * The tile shipped inert first — the initials avatar with a "Photo coming
 * soon" button — because profile pictures needed storage this app had not
 * built. Migration 0038 and `SosoGateway.uploadAvatar` built it; the layout
 * here is unchanged, which was the point of shipping the tile early.
 *
 * Picking a photo opens `AvatarCropper` to position and zoom it (that
 * screen, not this one, owns the crop); confirming it renders the chosen
 * square locally and shows it as a preview here.
 *
 * NOTHING IS STORED UNTIL SAVE. The bytes are uploaded, and the profile
 * pointed at them, only when Save runs. So Cancel leaves nothing behind —
 * no orphaned object in the bucket, no half-changed profile — and a failed
 * name validation cannot strand an uploaded file. The cost is a slightly
 * slower Save on a slow connection, which is the right side of that trade
 * for an action taken once in a while.
 *
 * The previous picture is deleted after the new one is saved, not before:
 * if the save fails, the profile still points at an object that still
 * exists. A delete that fails leaves an unreferenced file and nothing worse,
 * which is why it is not allowed to fail the save.
 *
 * WHY IT OWNS ITS OWN LOAD RATHER THAN TAKING THE PROFILE AS A PROP
 * ---------------------------------------------------------------------
 * It calls `gateway.myProfile()` on mount instead of receiving
 * `presence.me`, for two reasons: presence is disabled in demo mode (so a
 * prop would be null exactly where this screen still needs to work and be
 * testable), and the bio isn't part of the presence shape at all. One
 * source, loaded here, keeps the screen self-contained.
 */

interface PushControls {
  /** False where the browser or deployment can't do push at all — the toggle then explains why instead of lying. */
  available: boolean;
  subscribed: boolean;
  busy: boolean;
  onToggle: () => void;
}

interface ProfileSettingsProps {
  gateway: SosoGateway;
  demoMode: boolean;
  push: PushControls;
  onClose: () => void;
  /** Fired after a successful save so the People tab and header pick up the new name. */
  onSaved: (profile: MyProfile) => void;
}

export default function ProfileSettings({
  gateway,
  demoMode,
  push,
  onClose,
  onSaved,
}: ProfileSettingsProps) {
  const [loaded, setLoaded] = useState(false);
  const [handle, setHandle] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [bio, setBio] = useState("");
  // The path currently on the profile. Cleared to null by "Remove photo",
  // replaced by whatever `uploadAvatar` returns on save.
  const [avatarPath, setAvatarPath] = useState<AvatarPath>(null);
  // A picked-but-not-yet-uploaded image, and the object URL previewing it.
  // Both null in the ordinary case where the photo was not touched.
  const [pending, setPending] = useState<{ blob: Blob; previewUrl: string } | null>(null);
  const [preparing, setPreparing] = useState(false);
  // The decoded file currently being positioned. Non-null exactly while the
  // cropper is open; it owns bitmap and object-URL handles, so it is always
  // released through `closeCropper` rather than dropped.
  const [cropping, setCropping] = useState<DecodedAvatar | null>(null);
  const [rendering, setRendering] = useState(false);
  // The values as last saved, so "Save" can be disabled when nothing
  // actually changed — a save button that does nothing is a button that
  // makes you doubt whether it worked.
  const [saved, setSaved] = useState<{ name: string; bio: string; avatarPath: AvatarPath } | null>(
    null,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const profile = await gateway.myProfile();
        if (!alive || !profile) {
          if (alive) setLoaded(true);
          return;
        }
        setHandle(profile.handle);
        setName(profile.displayName);
        setBio(profile.bio);
        setAvatarPath(profile.avatarPath);
        setSaved({ name: profile.displayName, bio: profile.bio, avatarPath: profile.avatarPath });
      } catch {
        // Leaves the fields empty and the error visible rather than
        // pretending a blank profile loaded successfully.
        if (alive) setError(ERROR_MESSAGES_EN["soso/unknown"]);
      } finally {
        if (alive) setLoaded(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [gateway]);

  // An object URL is a live handle into the document, not a string: dropping
  // the last reference to one without revoking it keeps the whole decoded
  // image alive for the life of the page. Revoked when it is replaced and
  // when the screen closes.
  useEffect(() => {
    const url = pending?.previewUrl;
    return url ? () => URL.revokeObjectURL(url) : undefined;
  }, [pending]);

  const nameCheck = useMemo(() => validateDisplayName(name), [name]);
  const bioCheck = useMemo(() => validateBio(bio), [bio]);
  const remaining = bioRemaining(bio);

  // What the circle shows right now: a freshly picked image before it is
  // uploaded, otherwise whatever the profile already points at. Resolved
  // through the gateway because a stored path is not a URL — see
  // `SosoGateway.avatarUrl`.
  const avatarSrc = pending?.previewUrl ?? gateway.avatarUrl(avatarPath);

  const dirty =
    saved !== null &&
    (name.trim() !== saved.name.trim() ||
      bio.trim() !== saved.bio.trim() ||
      pending !== null ||
      avatarPath !== saved.avatarPath);
  // `cropping !== null` counts as busy so Save cannot fire while the cropper
  // is open. The overlay covers the header, so a mouse cannot reach it — but
  // there is no focus trap, so a keyboard still can, and saving mid-crop
  // would commit the profile WITHOUT the photo being positioned and then
  // unmount the cropper from under the person.
  const busy = saving || preparing || rendering || cropping !== null;
  const canSave = loaded && dirty && nameCheck.ok && bioCheck.ok && !busy;

  function closeCropper() {
    setCropping(null);
    setRendering(false);
  }

  // The ONLY place a decoded image is released, deliberately. It fires when
  // `cropping` is replaced by another photo, when it is set back to null,
  // and when the whole screen unmounts — which covers every exit including
  // the header's Cancel. Releasing at the call sites as well would double
  // up on all three. Same pattern as `pending` below, and safe under React
  // Strict Mode's double-invoked mount because `cropping` is null then.
  useEffect(() => {
    return () => cropping?.release();
  }, [cropping]);

  async function pickPhoto(file: File | null | undefined) {
    if (!file) return;
    setPreparing(true);
    setError(null);
    try {
      // Decode only. What part of it becomes the avatar is the next screen's
      // question, not something decided here on the person's behalf.
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
  }

  async function applyCrop(crop: SquareCrop) {
    if (!cropping) return;
    setRendering(true);
    setError(null);
    try {
      const blob = await renderAvatarCrop(cropping, crop);
      // Supersedes both the stored path and any earlier pick — `pending`
      // wins over `avatarPath` everywhere it is read, so choosing a photo
      // after pressing Remove means "use this one" without needing to undo
      // the removal first.
      setPending({ blob, previewUrl: URL.createObjectURL(blob) });
      closeCropper();
    } catch (err) {
      setError(
        err instanceof AvatarImageError
          ? avatarImageMessage(err.problem)
          : ERROR_MESSAGES_EN["soso/unknown"],
      );
      // Deliberately leaves the cropper open on failure: the person's
      // framing is still on screen and still valid, so a retry costs a tap
      // rather than repositioning the photo from scratch.
      setRendering(false);
    }
  }

  function removePhoto() {
    setPending(null);
    setAvatarPath(null);
    setError(null);
  }

  async function save() {
    if (!canSave || !nameCheck.ok || !bioCheck.ok) return;
    setSaving(true);
    setError(null);
    try {
      // The upload comes first and is the only step that can leave anything
      // behind on failure — an object nothing points at, which the next
      // successful save does not compound.
      const nextPath = pending ? await gateway.uploadAvatar(pending.blob) : avatarPath;
      const previousPath = saved?.avatarPath ?? null;

      const updated = await gateway.updateProfile({
        displayName: nameCheck.value,
        bio: bioCheck.value,
        avatarPath: nextPath,
      });

      // Only now that the profile no longer references it, and only if it
      // really was this person's own object. Deliberately not awaited into
      // the failure path: the save has already succeeded, and an orphaned
      // file is not worth telling anyone about, let alone worth making a
      // successful save look failed.
      if (previousPath && previousPath !== nextPath && isOwnAvatarPath(previousPath, updated.id)) {
        void gateway.deleteAvatar(previousPath).catch(() => {});
      }
      // Closes the screen rather than sitting on a "Saved ✓" state — Save
      // is the one action here with somewhere to go back TO (the profile
      // that just changed), so completing it should return there, the same
      // way submitting the handle step of sign-up moves on instead of
      // lingering on its own confirmation.
      onSaved(updated);
      onClose();
    } catch (err) {
      const code = (err as { code?: string; message?: string }).code
        ?? (err as { message?: string }).message
        ?? "";
      setError(
        code in ERROR_MESSAGES_EN
          ? ERROR_MESSAGES_EN[code as keyof typeof ERROR_MESSAGES_EN]
          : ERROR_MESSAGES_EN["soso/unknown"],
      );
    } finally {
      setSaving(false);
    }
  }

  const nameProblem =
    name.length > 0 && !nameCheck.ok
      ? nameCheck.problem === "empty"
        ? "Enter a name."
        : `At most ${DISPLAY_NAME_MAX} characters.`
      : null;

  return (
    <div className="settings-screen" role="dialog" aria-modal="true" aria-label="Edit profile">
      <header className="settings-header">
        <button type="button" className="settings-cancel" onClick={onClose}>
          Cancel
        </button>
        <h1>Edit profile</h1>
        <button type="button" className="settings-save" onClick={() => void save()} disabled={!canSave}>
          {saving ? "Saving…" : "Save"}
        </button>
      </header>

      {!loaded ? (
        <p className="settings-loading">Loading…</p>
      ) : (
        <div className="settings-scroll">
          {/* Avatar. The circle and the pill open the same picker; the
              hidden input is the only actual file control. */}
          <section className="settings-avatar-block">
            <input
              ref={fileInput}
              type="file"
              accept={AVATAR_MIME_TYPES.join(",")}
              hidden
              onChange={(e) => {
                void pickPhoto(e.target.files?.[0]);
                // Cleared so picking the SAME file twice in a row still
                // fires a change event — without this, re-choosing a photo
                // after removing it does nothing at all.
                e.target.value = "";
              }}
            />

            <button
              type="button"
              className="settings-avatar-button"
              onClick={() => fileInput.current?.click()}
              disabled={busy}
              aria-label={avatarSrc ? "Change profile photo" : "Add a profile photo"}
            >
              <span className="settings-avatar-wrap">
                <Avatar name={name || "You"} seed={handle ?? "you"} src={avatarSrc} size={92} />
                <span className="settings-avatar-badge" aria-hidden="true">
                  <Icon src={ICONS.plus} size={16} />
                </span>
              </span>
            </button>

            <div className="settings-avatar-actions">
              <button
                type="button"
                className="settings-avatar-cta"
                onClick={() => fileInput.current?.click()}
                disabled={busy}
              >
                {preparing ? "Preparing…" : avatarSrc ? "Change photo" : "Add photo"}
              </button>
              {avatarSrc && (
                <button
                  type="button"
                  className="settings-avatar-remove"
                  onClick={removePhoto}
                  disabled={busy}
                >
                  Remove
                </button>
              )}
            </div>
          </section>

          {/* Rendered inside the settings screen rather than as a sibling
              of it, so the surface it covers is the one it belongs to.
              Cancelling here returns to the form with the profile
              untouched — the file was decoded, never uploaded. */}
          {cropping && (
            <AvatarCropper
              image={cropping}
              busy={rendering}
              onConfirm={(crop) => void applyCrop(crop)}
              onCancel={closeCropper}
            />
          )}

          <section className="settings-group" aria-label="Profile">
            <label className="settings-field">
              <span className="settings-label">Display name</span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={DISPLAY_NAME_MAX + 10}
                placeholder="Your name"
                aria-invalid={nameProblem !== null}
              />
              <span className={`settings-sub${nameProblem ? " bad" : ""}`}>
                {nameProblem ?? "The name people see next to your posts."}
              </span>
            </label>

            <label className="settings-field">
              <span className="settings-label">Bio</span>
              <textarea
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                rows={3}
                placeholder="Say a little about yourself"
                aria-invalid={remaining < 0}
              />
              <span className={`settings-sub settings-counter${remaining < 0 ? " bad" : ""}`}>
                {remaining} / {BIO_MAX}
              </span>
            </label>

            {handle && (
              <div className="settings-field settings-readonly">
                <span className="settings-label">Username</span>
                <span className="settings-readonly-value">@{handle}</span>
                <span className="settings-sub">Chosen at sign-up and can&rsquo;t be changed here.</span>
              </div>
            )}
          </section>

          <section className="settings-group" aria-label="Notifications">
            <div className="settings-toggle-row">
              <div className="settings-toggle-text">
                <strong>Push notifications</strong>
                <span>
                  {push.available
                    ? "New pins near you, replies and likes on your posts, and direct messages."
                    : demoMode
                      ? "Notifications need the live backend — demo mode can't send them."
                      : "This browser can't receive notifications, or they're not configured for this deployment."}
                </span>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={push.available && push.subscribed}
                className={`settings-switch${push.available && push.subscribed ? " on" : ""}`}
                onClick={push.onToggle}
                disabled={!push.available || push.busy}
                aria-label="Push notifications"
              >
                <span className="settings-switch-knob" />
              </button>
            </div>
          </section>

          {error && <p className="settings-error">{error}</p>}
        </div>
      )}
    </div>
  );
}
