"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AVATAR_MIME_TYPES,
  conversationTitle,
  ERROR_MESSAGES_EN,
  GROUP_MAX_MEMBERS,
  GROUP_TITLE_MAX,
  type DmThread,
  type DmThreadMember,
  type Friend,
  type SosoGateway,
} from "soso-core";
import { Avatar } from "./Avatar";
import AvatarCropper from "./AvatarCropper";
import { ConversationAvatar } from "./ConversationAvatar";
import { Icon, ICONS } from "./Icon";
import { useGroupPhoto } from "./useGroupPhoto";

/**
 * Everything about a group that is not the messages.
 *
 * Reached by tapping the conversation's header, which is where every chat app
 * puts this and therefore the only place people look for it.
 *
 * WHY THE MEMBER LIST IS FETCHED HERE rather than taken from the thread. A
 * `DmThread` carries at most four members (see `soso.dm_members_json`), because
 * the inbox needs an avatar stack and a generated title and not twenty
 * profiles per row. This screen is the one place that wants all of them, so it
 * asks for them.
 *
 * WHO MAY DO WHAT, and why it is not all one permission:
 *
 *   * RENAME and CHANGE THE PHOTO — anyone. A group whose founder alone can
 *     fix a typo in its name is a group with a permanent typo in its name.
 *   * ADD — anyone, but only people THEY are mutual follows with. That check
 *     is the server's, per person, and it is the whole of what keeps a
 *     stranger from ever being put in a conversation with you.
 *   * REMOVE — the owner only, which is the one power the role buys.
 *   * LEAVE — anyone, always, with nobody's permission.
 */

interface GroupDetailsSheetProps {
  thread: DmThread;
  gateway: SosoGateway;
  /** Mutual follows, for the add-people list. */
  friends: Friend[];
  myId: string;
  /**
   * The signed-in user's own picture, for the "You" row in the member list.
   *
   * `soso.dm_members_json` deliberately excludes the viewer (every screen
   * that renders it already knows who they are), which is why "You" is a
   * row this component builds by hand rather than one it finds in
   * `members` — and why it needs this passed in rather than being able to
   * read it off that list the way every other member's picture is.
   */
  myAvatarPath: string | null;
  /** Hands back the thread as the server now reports it, so the header behind this updates. */
  onChanged: (thread: DmThread) => void;
  /** You left. The conversation is gone from under you, so the caller closes it entirely. */
  onLeft: () => void;
  onClose: () => void;
}

export default function GroupDetailsSheet({
  thread,
  gateway,
  friends,
  myId,
  myAvatarPath,
  onChanged,
  onLeft,
  onClose,
}: GroupDetailsSheetProps) {
  const [members, setMembers] = useState<DmThreadMember[]>(thread.members);
  const [loaded, setLoaded] = useState(false);
  const [mode, setMode] = useState<"detail" | "add">("detail");
  const [renaming, setRenaming] = useState(false);
  const [draftTitle, setDraftTitle] = useState(thread.title ?? "");
  const [picked, setPicked] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const photo = useGroupPhoto(gateway);

  const isOwner = thread.myRole === "owner";

  useEffect(() => {
    let alive = true;
    void gateway
      .listDmThreadMembers(thread.id)
      .then((rows) => {
        if (alive) setMembers(rows);
      })
      .catch(() => {
        // Leaves the four the thread already carried on screen. A failed
        // refresh should not empty a list that was partially right.
      })
      .finally(() => {
        if (alive) setLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, [gateway, thread.id]);

  /** Friends who are not already in the group — the only people Add can offer. */
  const addable = useMemo(() => {
    const inGroup = new Set([myId, ...members.map((m) => m.id)]);
    const q = query.trim().toLowerCase();
    return friends
      .filter((f) => !inGroup.has(f.id))
      .filter(
        (f) =>
          !q || f.displayName.toLowerCase().includes(q) || f.handle.toLowerCase().includes(q),
      )
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [friends, members, myId, query]);

  const room = GROUP_MAX_MEMBERS - (members.length + 1);

  function report(err: unknown) {
    const code = (err as { code?: string }).code as keyof typeof ERROR_MESSAGES_EN | undefined;
    setError(
      code && code in ERROR_MESSAGES_EN ? ERROR_MESSAGES_EN[code] : ERROR_MESSAGES_EN["soso/unknown"],
    );
  }

  /**
   * Every mutator here does the same three things — flip busy, hand the
   * returned thread up, refresh the member list — so they say it once.
   * `listDmThreadMembers` runs again rather than being patched locally because
   * the server is what decided who is in the group, including the cases this
   * screen cannot predict (somebody else added a person while this was open).
   */
  async function run(action: () => Promise<DmThread>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      onChanged(await action());
      setMembers(await gateway.listDmThreadMembers(thread.id));
    } catch (err) {
      report(err);
    } finally {
      setBusy(false);
    }
  }

  async function saveTitle() {
    const next = draftTitle.trim();
    setRenaming(false);
    if (next === (thread.title ?? "")) return;
    await run(() => gateway.renameGroupThread(thread.id, next || null));
  }

  async function savePhoto() {
    setBusy(true);
    setError(null);
    try {
      const path = await photo.upload();
      if (!path) return;
      onChanged(await gateway.setGroupThreadPhoto(thread.id, path));
      photo.clear();
    } catch (err) {
      report(err);
    } finally {
      setBusy(false);
    }
  }

  // Uploading the instant a crop is confirmed, rather than behind a Save
  // button: this screen has no save step of its own — every other control on
  // it commits immediately — and a photo that sat pending until you found a
  // button would be the one thing here that silently did not apply.
  useEffect(() => {
    if (photo.previewUrl) void savePhoto();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photo.previewUrl]);

  async function addPicked() {
    if (picked.length === 0) return;
    await run(() => gateway.addGroupMembers(thread.id, picked));
    setPicked([]);
    setQuery("");
    setMode("detail");
  }

  async function leave() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await gateway.leaveGroupThread(thread.id);
      onLeft();
    } catch (err) {
      report(err);
      setBusy(false);
    }
  }

  if (mode === "add") {
    return (
      <div className="group-sheet" role="dialog" aria-modal="true" aria-label="Add people">
        <header className="group-sheet-head">
          <button
            type="button"
            className="dm-thread-back"
            onClick={() => {
              setMode("detail");
              setPicked([]);
              setQuery("");
            }}
            aria-label="Back"
          >
            <Icon src={ICONS.chevronLeft} size={17} />
          </button>
          <h2>Add people</h2>
          <button
            type="button"
            className="group-sheet-next"
            onClick={() => void addPicked()}
            disabled={picked.length === 0 || busy}
          >
            {busy ? "Adding…" : picked.length > 0 ? `Add ${picked.length}` : "Add"}
          </button>
        </header>

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

        <p className="group-sheet-note">
          {/* Said here rather than discovered through an error: the rule is the
              one thing about groups that is not obvious, and this is the screen
              where it bites. */}
          You can only add people you follow each other with. Room for {room} more.
        </p>
        {error && <p className="chat-error">{error}</p>}

        <div className="group-sheet-list">
          {addable.length === 0 ? (
            <p className="chat-empty">
              {query.trim()
                ? `Nobody matches “${query.trim()}”.`
                : "Everyone you follow each other with is already here."}
            </p>
          ) : (
            <ul className="group-picker">
              {addable.map((friend) => {
                const on = picked.includes(friend.id);
                return (
                  <li key={friend.id}>
                    <button
                      type="button"
                      className={`group-picker-row${on ? " on" : ""}`}
                      onClick={() =>
                        setPicked((current) =>
                          current.includes(friend.id)
                            ? current.filter((x) => x !== friend.id)
                            : current.length >= room
                              ? current
                              : [...current, friend.id],
                        )
                      }
                      disabled={!on && picked.length >= room}
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
      </div>
    );
  }

  return (
    <div className="group-sheet" role="dialog" aria-modal="true" aria-label="Group details">
      <header className="group-sheet-head">
        <button type="button" className="dm-thread-back" onClick={onClose} aria-label="Back">
          <Icon src={ICONS.chevronLeft} size={17} />
        </button>
        <h2>Group</h2>
        <span className="group-sheet-next placeholder" aria-hidden="true" />
      </header>

      <div className="group-sheet-list">
        <div className="group-hero">
          <input
            ref={fileInput}
            type="file"
            accept={AVATAR_MIME_TYPES.join(",")}
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) photo.pick(file);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            className="group-hero-photo"
            onClick={() => fileInput.current?.click()}
            disabled={busy || photo.preparing}
            aria-label="Change the group photo"
          >
            <ConversationAvatar thread={thread} gateway={gateway} size={88} />
            <span className="group-photo-badge" aria-hidden="true">
              <Icon src={ICONS.image} size={12} />
            </span>
          </button>

          {renaming ? (
            <form
              className="group-hero-rename"
              onSubmit={(e) => {
                e.preventDefault();
                void saveTitle();
              }}
            >
              <input
                type="text"
                value={draftTitle}
                onChange={(e) => setDraftTitle(e.target.value)}
                maxLength={GROUP_TITLE_MAX}
                placeholder={conversationTitle(thread)}
                aria-label="Group name"
                autoFocus
                // Committing on blur as well as on submit: this is a one-field
                // form with no visible Save, so tapping away from it has to
                // mean the same thing as pressing return.
                onBlur={() => void saveTitle()}
              />
              <button type="submit" aria-label="Save the name">
                <Icon src={ICONS.check} size={14} />
              </button>
            </form>
          ) : (
            <button
              type="button"
              className="group-hero-name"
              onClick={() => {
                setDraftTitle(thread.title ?? "");
                setRenaming(true);
              }}
            >
              <strong>{conversationTitle(thread)}</strong>
              <span>
                {thread.memberCount} {thread.memberCount === 1 ? "member" : "members"} · tap to rename
              </span>
            </button>
          )}

          {photo.error && <p className="chat-error">{photo.error}</p>}
          {error && <p className="chat-error">{error}</p>}
        </div>

        <button
          type="button"
          className="group-action"
          onClick={() => setMode("add")}
          disabled={busy || room <= 0}
        >
          <Icon src={ICONS.personAdd} size={17} />
          <span>{room > 0 ? "Add people" : `Full — ${GROUP_MAX_MEMBERS} people`}</span>
        </button>

        <h3 className="group-section">
          {loaded ? `${thread.memberCount} members` : "Members"}
        </h3>

        <ul className="group-members">
          <li>
            <span className="group-member-row">
              {/* `src` was missing entirely here — the viewer's own row
                  always showed the fallback initial, never the picture on
                  their own profile, regardless of whether one was set. */}
              <Avatar name="You" seed={myId} src={gateway.avatarUrl(myAvatarPath)} size={40} />
              <span className="group-picker-who">
                <strong>You</strong>
                <span>{isOwner ? "Created this group" : "Member"}</span>
              </span>
            </span>
          </li>
          {members.map((member) => (
            <li key={member.id}>
              <span className="group-member-row">
                <Avatar
                  name={member.displayName}
                  seed={member.handle}
                  src={gateway.avatarUrl(member.avatarPath)}
                  size={40}
                />
                <span className="group-picker-who">
                  <strong>{member.displayName}</strong>
                  <span>
                    {/* A blocked member is marked rather than hidden: their
                        messages are already filtered out server-side, and a
                        name in this list whose messages silently never appear
                        is more confusing than saying why.

                        The owner's role label used to REPLACE their @handle
                        rather than sit next to it, which was fine as long as
                        a display name was unique enough to place — it isn't:
                        two people named "Alex" in the same group left no way
                        to tell which one created it. Both now show. */}
                    {member.blocked
                      ? "Blocked — you don't see their messages"
                      : member.role === "owner"
                        ? `Created this group · @${member.handle}`
                        : `@${member.handle}`}
                  </span>
                </span>
                {isOwner && (
                  <button
                    type="button"
                    className="group-member-remove"
                    onClick={() => void run(() => gateway.removeGroupMember(thread.id, member.id))}
                    disabled={busy}
                    aria-label={`Remove ${member.displayName}`}
                    title={`Remove ${member.displayName}`}
                  >
                    <Icon src={ICONS.personRemove} size={15} />
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>

        {confirmLeave ? (
          <div className="group-leave-confirm">
            <p>
              Leave <strong>{conversationTitle(thread)}</strong>? You&rsquo;ll stop receiving its
              messages, and someone still in it has to add you back.
            </p>
            <button type="button" className="group-action danger" onClick={() => void leave()} disabled={busy}>
              {busy ? "Leaving…" : "Leave group"}
            </button>
            <button type="button" className="group-action" onClick={() => setConfirmLeave(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <button type="button" className="group-action danger" onClick={() => setConfirmLeave(true)}>
            <Icon src={ICONS.block} size={16} />
            <span>Leave group</span>
          </button>
        )}
      </div>

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
