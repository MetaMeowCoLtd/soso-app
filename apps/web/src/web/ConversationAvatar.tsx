"use client";

import type { DmThread, SosoGateway } from "soso-core";
import { conversationTitle } from "soso-core";
import { Avatar } from "./Avatar";

/**
 * A conversation, as a circle.
 *
 * Three cases behind one component, because four surfaces render this (the
 * inbox row, the thread header, the group detail sheet, and the new-group
 * sheet's preview) and each of them would otherwise repeat the same ternary:
 *
 *   * A DIRECT thread is the other person's `Avatar`, unchanged.
 *   * A GROUP WITH A PHOTO is that photo, in the same circle.
 *   * A GROUP WITHOUT ONE is a stack of its first two members' avatars, which
 *     is what Instagram, Messenger and LINE all do and for the same reason:
 *     most groups are never given a picture, so the no-picture case is the
 *     normal one and has to be legible rather than apologetic. Two overlapping
 *     coloured discs also make a group instantly distinguishable from a DM in
 *     a scrolling list, which a single grey "group" glyph would not.
 *
 * WHY NOT MORE THAN TWO IN THE STACK. Three 26px discs inside a 46px circle
 * are three illegible smudges. Two at 62% of the outer size stay recognisable
 * as the people they are, which is the only thing the stack is for.
 */

interface ConversationAvatarProps {
  thread: DmThread;
  /** Needed to turn stored avatar paths into URLs — see `Avatar`'s own note on why it takes a URL. */
  gateway: SosoGateway;
  size?: number;
  /**
   * The presence dot, for a direct thread only. A group has no single online
   * state and showing the dot for "somebody in here is online" would be a
   * different claim than the one it makes everywhere else in this app.
   */
  online?: boolean;
}

export function ConversationAvatar({ thread, gateway, size = 46, online }: ConversationAvatarProps) {
  if (thread.kind === "direct") {
    return (
      <Avatar
        // Never actually null on a direct thread; the fallbacks match
        // `conversationTitle`'s so a half-loaded row cannot show one word in
        // its title and a different initial in its circle.
        name={thread.otherName ?? "Someone"}
        seed={thread.otherHandle ?? thread.id}
        src={gateway.avatarUrl(thread.otherAvatarPath)}
        size={size}
        online={online}
      />
    );
  }

  if (thread.photoPath) {
    return (
      <Avatar
        // The title, so a photo that fails to load falls back to the group's
        // own initial rather than to a question mark.
        name={conversationTitle(thread)}
        // The thread id, not the title: a group that gets renamed should not
        // change colour, and two groups called "Lunch" should not be the same
        // one.
        seed={thread.id}
        src={gateway.avatarUrl(thread.photoPath)}
        size={size}
      />
    );
  }

  const stack = thread.members.slice(0, 2);

  // A group whose other members have all deleted their accounts. One disc
  // seeded on the thread is still a stable, distinct mark for it.
  if (stack.length === 0) {
    return <Avatar name={conversationTitle(thread)} seed={thread.id} size={size} />;
  }

  const inner = Math.round(size * 0.62);

  return (
    <span className="convo-stack" style={{ width: size, height: size }} aria-hidden="true">
      {stack.map((member, i) => (
        <span
          key={member.id}
          className={`convo-stack-slot${i === 0 ? " back" : " front"}`}
          // Positioned inline rather than in CSS because both offsets are
          // functions of `size`, which varies per surface (26px in a member
          // row, 46px in the inbox, 76px in the detail sheet).
          style={
            i === 0
              ? { top: 0, left: 0 }
              : { top: size - inner, left: size - inner }
          }
        >
          <Avatar
            name={member.displayName}
            seed={member.handle}
            src={gateway.avatarUrl(member.avatarPath)}
            size={inner}
          />
        </span>
      ))}
    </span>
  );
}
