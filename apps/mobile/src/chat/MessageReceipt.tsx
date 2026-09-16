import { StyleSheet, View } from "react-native";

import { formatSeenAt } from "../core";
import { COLORS } from "../theme/tokens";
import { AppText } from "../ui/AppText";
import { Avatar } from "../ui/Avatar";

/**
 * Ported from apps/web/src/web/MessageReceipt.tsx. Same discriminated
 * `receipt` union, same three renderings — a DM gets a sentence, the room
 * gets a count, a group gets faces (Instagram-style) — unchanged, since
 * none of it depends on the DOM.
 */
export type MessageReceiptState =
  | { kind: "seen-at"; readAt: string }
  | { kind: "count"; count: number }
  | { kind: "people"; readers: { id: string; name: string; handle: string; src: string | null }[] };

const MAX_FACES = 5;

export default function MessageReceipt({ receipt, nowSeconds }: { receipt: MessageReceiptState; nowSeconds: number }) {
  if (receipt.kind === "people") {
    const shown = receipt.readers.slice(0, MAX_FACES);
    const hidden = receipt.readers.length - shown.length;
    return (
      <View style={styles.faces} accessibilityLabel={`Seen by ${receipt.readers.map((r) => r.name).join(", ")}`}>
        {shown.map((reader, i) => (
          <View key={reader.id} style={i > 0 && styles.faceOverlap}>
            <Avatar name={reader.name} seed={reader.handle} src={reader.src} size={16} />
          </View>
        ))}
        {hidden > 0 && <AppText style={styles.more}>+{hidden}</AppText>}
      </View>
    );
  }

  if (receipt.kind === "count") {
    return (
      <AppText style={styles.text}>
        Seen by {receipt.count} {receipt.count === 1 ? "person" : "people"}
      </AppText>
    );
  }

  return (
    <AppText style={styles.text}>
      {formatSeenAt(Math.floor(new Date(receipt.readAt).getTime() / 1000), nowSeconds)}
    </AppText>
  );
}

const styles = StyleSheet.create({
  text: { fontSize: 11, color: COLORS.muted, marginTop: 2 },
  faces: { flexDirection: "row", alignItems: "center", marginTop: 2 },
  faceOverlap: { marginLeft: -4 },
  more: { fontSize: 11, color: COLORS.muted, marginLeft: 4 },
});
