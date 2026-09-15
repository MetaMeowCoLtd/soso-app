import { Pressable, StyleSheet, type StyleProp, type ViewStyle } from "react-native";

import { COLORS } from "../theme/tokens";
import { AppText } from "./AppText";

interface ButtonProps {
  label: string;
  onPress: () => void;
  /** `primary`: solid teal, for the one main action on a screen. `secondary`: outlined, everything else. */
  variant?: "primary" | "secondary";
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}

/**
 * A minimal two-variant button. Not a port of any single web component —
 * the web app styles buttons ad hoc per screen in globals.css rather than
 * through one shared component — but built from the same token palette
 * (`COLORS.teal` primary, `COLORS.line` outline) so anything using it reads
 * as part of the same app.
 */
export function Button({ label, onPress, variant = "primary", disabled, style }: ButtonProps) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.base,
        variant === "primary" ? styles.primary : styles.secondary,
        disabled && styles.disabled,
        pressed && !disabled && styles.pressed,
        style,
      ]}
    >
      <AppText style={variant === "primary" ? styles.primaryLabel : styles.secondaryLabel}>{label}</AppText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  primary: { backgroundColor: COLORS.teal },
  secondary: { backgroundColor: "transparent", borderWidth: 1, borderColor: COLORS.line },
  disabled: { opacity: 0.5 },
  pressed: { opacity: 0.85 },
  primaryLabel: { color: "#ffffff", fontWeight: "600", fontSize: 15 },
  secondaryLabel: { color: COLORS.ink, fontWeight: "600", fontSize: 15 },
});
