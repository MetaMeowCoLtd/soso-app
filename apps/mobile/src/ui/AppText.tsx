import { Text, type TextProps } from "react-native";

import { COLORS } from "../theme/tokens";

/**
 * Base text component. Web's body rule (globals.css) sets
 * `color:var(--ink)` and a rounded system-font stack
 * (`ui-rounded, "SF Pro Rounded", "Avenir Next", Arial, sans-serif`) once,
 * globally, so every element inherits it. RN has no such cascade — every
 * `<Text>` is independent — so this exists as the one place that default
 * lives, rather than repeating `color: COLORS.ink` at every call site.
 *
 * `fontFamily` is left unset here rather than forced to a specific rounded
 * face: "ui-rounded" is a CSS-only keyword with no RN/native equivalent,
 * and matching the web app's exact rounded system font on both iOS and
 * Android is a font-loading decision for its own checkpoint, not this one.
 * This falls back to each platform's default system font in the meantime.
 */
export function AppText({ style, ...props }: TextProps) {
  return <Text style={[{ color: COLORS.ink }, style]} {...props} />;
}
