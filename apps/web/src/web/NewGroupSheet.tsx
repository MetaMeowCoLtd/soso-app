"use client";

import { useMemo, useRef, useState } from "react";
import {
  ERROR_MESSAGES_EN,
  GROUP_MAX_MEMBERS,
  GROUP_MIN_OTHERS,
  GROUP_TITLE_MAX,
  groupTitleFromMembers,
  AVATAR_MIME_TYPES,
  type DmThread,
  type DmThreadMember,
  type Friend,
  type SosoGateway,
} from "soso-core";
import { Avatar } from "./Avatar";
import AvatarCropper from "./AvatarCropper";
import { Icon, ICONS } from "./Icon";
import { useGroupPhoto } from "./useGroupPhoto";

/**
 * Starting a group: pick people, then name it.
 *
 * TWO STEPS, NOT ONE, and not three. Instagram asks for the people and then
 * drops you straight into an unnamed conversation; LINE asks for people, then
 * name and picture, then creates. This does LINE's, because the request this
 * was built for was explicitly "select friends, give it a name, choose a
 * picture" — but it borrows Instagram's most important property, which is that
 * NEITHER THE NAME NOR THE PICTURE IS REQUIRED. Both steps can be crossed with
 * one tap, and an unnamed group renders from its members' names (see
 * `groupTitleFromMembers`) rather than sitting in the inbox as "Untitled".
 *
 * SELECTING ONE PERSON OPENS THE DM INSTEAD. The primary button changes from
 * "Next" to "Message" the moment exactly one friend is selected, because
 * that is what the selection means, and answering it with a two-person group
 * would leave that pair with two conversations and two unread badges.
 * `create_group_thread` refuses the case server-side as well — see
 * `GROUP_MIN_OTHERS` — so this is the courteous half of a rule that is
 * actually enforced elsewhere.
 *
 * WHY THE SELECTION IS A ROW OF CHIPS AND NOT JUST CHECKMARKS. The list
 * scrolls and the search box filters it, so by the time you have picked five
 * people out of sixty, none of the five are necessarily on screen. The chip row
 * is the only place the current selection is visible as a whole, and each chip
 * is its own remove button — which is also how you undo a mis-tap without
 * searching back for the person you did not mean to add.
 */

interface NewGroupSheetProps {
  gateway: SosoGateway;
  /** Mutual follows, the only people who may be put in a group. Supplied by usePresence. */
  friends: Friend[];
  onCreated: (thread: DmThread) => void;
  /** Selecting exactly one person means "message them" — page.tsx owns opening that. */
  onOpenDirect: (userId: string) => void;
  onClose: () => void;
}

export default function NewGroupSheet({
  gateway,
  friends,
  onCreated,
  onOpenDirect,
  onClose,
}: NewGroupSheetProps) {
  const [step, setStep] = useState<"who" | "about">("who");
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const photo = useGroupPhoto(gateway);

  const byId = useMemo(() => new Map(friends.map((f) => [f.id, f])), [friends]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = q
      ? friends.filter(
          (f) => f.displayName.toLowerCase().includes(q) || f.handle.toLowerCase().includes(q),
        )
      : friends;
    // Online first, then alphabetically — the same ordering the Friends tab
    // uses, so the two lists do not disagree about who is at the top.
    return [...rows].sort((a, b) => {
      if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1;
      return a.displayName.localeCompare(b.displayName);
    });
  }, [friends, query]);

  // Selection order, not friends-list order: the chip row reads as a record of
  // what you tapped, and re-sorting it under your finger is disorienting.
  const chosen = useMemo(
    () => selected.map((id) => byId.get(id)).filter((f): f is Friend => Boolean(f)),
    [selected, byId],
  );

  /** The name the group will show if you do not type one. */
  const generatedTitle = useMemo(
    () =>
      groupTitleFromMembers(
        chosen.map(
          (f): DmThreadMember => ({
            id: f.id,
            handle: f.handle,
            displayName: f.displayName,
            avatarPath: f.avatarPath,
            role: "member",
            blocked: false,
          }),
        ),
        chosen.length,
      ),
    [chosen],
  );

  // The creator counts toward the cap, so the number of others that fit is one
  // fewer than the cap itself.
  const full = selected.length >= GROUP_MAX_MEMBERS - 1;

  function toggle(id: string) {
    setError(null);
    setSelected((current) => {
      if (current.includes(id)) return current.filter((x) => x !== id);
      if (current.length >= GROUP_MAX_MEMBERS - 1) return current;
      return [...current, id];
    });
  }

  function advance() {
    if (selected.length === 1) {
      // Not a group. Hand it to the DM path and close, which is what the
      // button has been saying it would do since the second person was
      // deselected.
      onOpenDirect(selected[0]!);
      onClose();
      return;
    }
    if (selected.length < GROUP_MIN_OTHERS) return;
    setError(null);
    setStep("about");
  }

  async function create() {
    if (creating || selected.length < GROUP_MIN_OTHERS) return;
    setCreating(true);
    setError(null);
    try {
      // The photo goes up first, and is the only step that can leave anything
      // behind on failure — an object nothing points at, which costs nothing
      // and which a retry does not compound. Same order, for the same reason,
      // as saving a profile.
      const photoPath = await photo.upload();
      const thread = await gateway.createGroupThread({
        title: title.trim() || null,
        memberIds: selected,
        photoPath,
      });
      onCreated(thread);
    } catch (err) {
      const code = (err as { code?: string }).code as keyof typeof ERROR_MESSAGES_EN | undefined;
      setError(
        code && code in ERROR_MESSAGES_EN ? ERROR_MESSAGES_EN[code] : ERROR_MESSAGES_EN["soso/unknown"],
      );
      // Deliberately stays open. Everything the person chose is still on
      // screen and still valid, so a retry is one tap rather than a rebuild.
      setCreating(false);
    }
  }

  return (
    <div className="group-sheet" role="dialog" aria-modal="true" aria-label="New group">
      <header className="group-sheet-head">
        <button
          type="button"
          className="dm-thread-back"
          onClick={() => (step === "about" ? setStep("who") : onClose())}
          aria-label={step === "about" ? "Back to choosing people" : "Close"}
        >
          <Icon src={step === "about" ? ICONS.chevronLeft : ICONS.close} size={step === "about" ? 17 : 13} />
        </button>
        <h2>{step === "who" ? "New group" : "Name this group"}</h2>
        {step === "who" ? (
          <button
            type="button"
            className="group-sheet-next"
            onClick={advance}
            disabled={selected.length === 0}
          >
            {/* One person selected is not a group, and the button says so
                rather than refusing a tap without explaining itself. */}
            {selected.length === 1 ? "Message" : "Next"}
          </button>
        ) : (
          <button type="button" className="group-sheet-next" onClick={() => void create()} disabled={creating}>
            {creating ? "Creating…" : "Create"}
          </button>
        )}
      </header>

      {step === "who" ? (
        <>
          <div className="group-sheet-search">
            <Icon src={ICONS.search} size={15} />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search friends"
              aria-label="Search friends"
              autoFocus
            />
          </div>

          {chosen.length > 0 && (
            <ul className="group-chips" aria-label="Selected">
              {chosen.map((friend) => (
                <li key={friend.id}>
                  <button
                    type="button"
                    className="group-chip"
                    onClick={() => toggle(friend.id)}
                    aria-label={`Remove ${friend.displayName}`}
                  >
                    <Avatar
                      name={friend.displayName}
                      seed={friend.handle}
                      src={gateway.avatarUrl(friend.avatarPath)}
                      size={20}
                    />
                    <span>{friend.displayName}</span>
                    <Icon src={ICONS.close} size={9} />
                  </button>
                </li>
              ))}
            </ul>
          )}

          {full && (
            <p className="group-sheet-note">
              That&rsquo;s {GROUP_MAX_MEMBERS} people including you — the most a group can hold.
            </p>
          )}
          {error && <p className="chat-error">{error}</p>}

          <div className="group-sheet-list">
            {friends.length === 0 ? (
              <div className="people-blank">
                <Icon src={ICONS.people} size={26} />
                <strong>No friends yet</strong>
                <p>
                  A group is made from people you follow each other with. Follow someone from the
                  Friends tab and have them follow you back.
                </p>
              </div>
            ) : matches.length === 0 ? (
              <p className="chat-empty">Nobody matches “{query.trim()}”.</p>
            ) : (
              <ul className="group-picker">
                {matches.map((friend) => {
                  const on = selected.includes(friend.id);
                  return (
                    <li key={friend.id}>
                      <button
                        type="button"
                        className={`group-picker-row${on ? " on" : ""}`}
                        onClick={() => toggle(friend.id)}
                        // Disabled only when the group is full AND this person
                        // is not already in it, so the last-selected people
                        // stay removable at the cap.
                        disabled={full && !on}
                        aria-pressed={on}
                      >
                        <Avatar
                          name={friend.displayName}
                          seed={friend.handle}
                          src={gateway.avatarUrl(friend.avatarPath)}
                          size={42}
                          online={friend.isOnline}
                        />
                        <span className="group-picker-who">
                          <strong>{friend.displayName}</strong>
                          <span>@{friend.handle}</span>
                        </span>
                        <span className={`group-check${on ? " on" : ""}`} aria-hidden="true">
                          {on && <Icon src={ICONS.check} size={12} />}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      ) : (
        <div className="group-sheet-about">
          <input
            ref={fileInput}
            type="file"
            accept={AVATAR_MIME_TYPES.join(",")}
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) photo.pick(file);
              // Cleared so picking the same file twice in a row still fires a
              // change event.
              e.target.value = "";
            }}
          />

          <button
            type="button"
            className="group-photo-pick"
            onClick={() => fileInput.current?.click()}
            disabled={photo.preparing}
            aria-label={photo.previewUrl ? "Change the group photo" : "Add a group photo"}
          >
            {photo.previewUrl ? (
              <img src={photo.previewUrl} alt="" />
            ) : (
              <span className="group-photo-empty">
                <Icon src={ICONS.image} size={22} />
              </span>
            )}
            <span className="group-photo-badge" aria-hidden="true">
              <Icon src={ICONS.plus} size={11} />
            </span>
          </button>

          <p className="group-photo-hint">
            {photo.preparing
              ? "Opening that photo…"
              : photo.previewUrl
                ? "Tap to pick a different one"
                : "Add a photo — optional"}
          </p>
          {photo.previewUrl && (
            <button type="button" className="group-photo-remove" onClick={photo.clear}>
              Remove photo
            </button>
          )}

          <label className="group-name-field">
            <span>Group name</span>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={GROUP_TITLE_MAX}
              // The generated name, so the field shows what leaving it blank
              // will actually produce rather than the word "optional".
              placeholder={generatedTitle}
              aria-label="Group name"
              autoFocus
            />
          </label>
          <p className="group-name-hint">
            Leave it empty and the group is called <strong>{generatedTitle}</strong>. Anyone in the
            group can rename it later.
          </p>

          <ul className="group-chips wrapped" aria-label="Members">
            {chosen.map((friend) => (
              <li key={friend.id}>
                <span className="group-chip static">
                  <Avatar
                    name={friend.displayName}
                    seed={friend.handle}
                    src={gateway.avatarUrl(friend.avatarPath)}
                    size={20}
                  />
                  <span>{friend.displayName}</span>
                </span>
              </li>
            ))}
          </ul>

          {(photo.error || error) && <p className="chat-error">{photo.error ?? error}</p>}
        </div>
      )}

      {/* Rendered inside the sheet rather than as a sibling, so the surface it
          covers is the one it belongs to. Cancelling returns to the form with
          nothing uploaded — the file was decoded, never sent. */}
      {photo.cropping && (
        <AvatarCropper
          image={photo.cropping}
          busy={photo.rendering}
          onConfirm={photo.applyCrop}
          onCancel={photo.closeCropper}
        />
      )}
    </div>
  );
}
