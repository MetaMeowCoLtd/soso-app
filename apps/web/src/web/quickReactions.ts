/**
 * The emoji offered in a message's long-press reaction strip — shared
 * between ChatPanel (the room) and DmThreadView (direct messages) so the
 * two can never quietly drift apart. That guarantee is the whole reason
 * this is its own module instead of a constant copied into each file: the
 * room is the one place this list gets edited, and importing it here is
 * what makes DMs follow along automatically rather than by remembering to.
 *
 * Six, because that is what fits across a narrow phone at a comfortable
 * tap size, and no "+" to open a full picker: neither surface has an
 * emoji picker component, and a button that opens nothing is worse than a
 * shorter row.
 */
export const QUICK_REACTIONS = ["❤️", "😂", "😮", "😢", "🙏", "👍"] as const;
