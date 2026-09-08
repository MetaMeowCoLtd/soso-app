"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  bioRemaining,
  BIO_MAX,
  DISPLAY_NAME_MAX,
  ERROR_MESSAGES_EN,
  validateBio,
  validateDisplayName,
  type MyProfile,
  type SosoGateway,
} from "soso-core";
import { Avatar } from "./Avatar";
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
 * WHY THE AVATAR TILE IS PRESENT BUT INERT
 * ---------------------------------------------------------------------
 * Profile pictures need an image-storage subsystem this app has not built
 * (see Avatar.tsx: every avatar is hash-coloured initials). Rather than
 * omit it and reshape the screen when it lands, the tile is here, showing
 * the initials avatar the rest of the app already uses, marked clearly as
 * not-yet-available. It reads as "coming", not as "broken", and the layout
 * is already the one the upload will slot into.
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
  // The values as last saved, so "Save" can be disabled when nothing
  // actually changed — a save button that does nothing is a button that
  // makes you doubt whether it worked.
  const [saved, setSaved] = useState<{ name: string; bio: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const justSavedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
        setSaved({ name: profile.displayName, bio: profile.bio });
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

  useEffect(
    () => () => {
      if (justSavedTimer.current) clearTimeout(justSavedTimer.current);
    },
    [],
  );

  const nameCheck = useMemo(() => validateDisplayName(name), [name]);
  const bioCheck = useMemo(() => validateBio(bio), [bio]);
  const remaining = bioRemaining(bio);

  const dirty =
    saved !== null && (name.trim() !== saved.name.trim() || bio.trim() !== saved.bio.trim());
  const canSave = loaded && dirty && nameCheck.ok && bioCheck.ok && !saving;

  async function save() {
    if (!canSave || !nameCheck.ok || !bioCheck.ok) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await gateway.updateProfile({ displayName: nameCheck.value, bio: bioCheck.value });
      setName(updated.displayName);
      setBio(updated.bio);
      setSaved({ name: updated.displayName, bio: updated.bio });
      onSaved(updated);
      setJustSaved(true);
      if (justSavedTimer.current) clearTimeout(justSavedTimer.current);
      justSavedTimer.current = setTimeout(() => setJustSaved(false), 2200);
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
          {saving ? "Saving…" : justSaved ? "Saved ✓" : "Save"}
        </button>
      </header>

      {!loaded ? (
        <p className="settings-loading">Loading…</p>
      ) : (
        <div className="settings-scroll">
          {/* Avatar — present, styled, and deliberately not yet wired to an
              upload (see the component comment). */}
          <section className="settings-avatar-block">
            <div className="settings-avatar-wrap">
              <Avatar name={name || "You"} seed={handle ?? "you"} size={92} />
              <span className="settings-avatar-badge" aria-hidden="true">
                <Icon src={ICONS.plus} size={16} />
              </span>
            </div>
            <button type="button" className="settings-avatar-cta" disabled title="Photo upload is coming soon">
              Photo coming soon
            </button>
          </section>

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
