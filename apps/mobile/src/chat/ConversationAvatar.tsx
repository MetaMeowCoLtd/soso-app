import { StyleSheet, View } from "react-native";

import { conversationTitle, type DmThread, type SosoGateway } from "../core";
import { Avatar } from "../ui/Avatar";

/**
 * Ported from apps/web/src/web/ConversationAvatar.tsx. The three cases
 * (direct, group with a photo, group without one — a stack of the first
 * two members) are pure layout decisions and move unchanged; only the
 * stack's absolute positioning becomes RN `style` objects instead of CSS
 * classes.
 */
interface ConversationAvatarProps {
  thread: DmThread;
  gateway: SosoGateway;
  size?: number;
  online?: boolean;
}

export function ConversationAvatar({ thread, gateway, size = 46, online }: ConversationAvatarProps) {
  if (thread.kind === "direct") {
    return (
      <Avatar
        name={thread.otherName ?? "Someone"}
        seed={thread.otherHandle ?? thread.id}
        src={gateway.avatarUrl(thread.otherAvatarPath)}
        size={size}
        online={online}
      />
    );
  }

  if (thread.photoPath) {
    return <Avatar name={conversationTitle(thread)} seed={thread.id} src={gateway.avatarUrl(thread.photoPath)} size={size} />;
  }

  const stack = thread.members.slice(0, 2);

  if (stack.length === 0) {
    return <Avatar name={conversationTitle(thread)} seed={thread.id} size={size} />;
  }

  const inner = Math.round(size * 0.62);

  return (
    <View style={{ width: size, height: size }}>
      {stack.map((member, i) => (
        <View
          key={member.id}
          style={[styles.slot, i === 0 ? { top: 0, left: 0 } : { top: size - inner, left: size - inner, zIndex: 1 }]}
        >
          <Avatar name={member.displayName} seed={member.handle} src={gateway.avatarUrl(member.avatarPath)} size={inner} />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  slot: { position: "absolute" },
});
