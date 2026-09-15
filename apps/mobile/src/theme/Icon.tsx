import type { FC } from "react";
import type { SvgProps } from "react-native-svg";

import ArrowUp from "../../assets/icons/ui/arrow-up.svg";
import Bell from "../../assets/icons/ui/bell.svg";
import BellMuted from "../../assets/icons/ui/bell-muted.svg";
import Block from "../../assets/icons/ui/block.svg";
import Chat from "../../assets/icons/ui/chat.svg";
import Check from "../../assets/icons/ui/check.svg";
import ChevronLeft from "../../assets/icons/ui/chevron-left.svg";
import Close from "../../assets/icons/ui/close.svg";
import Comment from "../../assets/icons/ui/comment.svg";
import Copy from "../../assets/icons/ui/copy.svg";
import Download from "../../assets/icons/ui/download.svg";
import Eraser from "../../assets/icons/ui/eraser.svg";
import Feed from "../../assets/icons/ui/feed.svg";
import Heart from "../../assets/icons/ui/heart.svg";
import HeartFilled from "../../assets/icons/ui/heart-filled.svg";
import ImageIcon from "../../assets/icons/ui/image.svg";
import Locate from "../../assets/icons/ui/locate.svg";
import Lock from "../../assets/icons/ui/lock.svg";
import MapIcon from "../../assets/icons/ui/map.svg";
import Minimize from "../../assets/icons/ui/minimize.svg";
import More from "../../assets/icons/ui/more.svg";
import People from "../../assets/icons/ui/people.svg";
import PersonAdd from "../../assets/icons/ui/person-add.svg";
import PersonRemove from "../../assets/icons/ui/person-remove.svg";
import Place from "../../assets/icons/ui/place.svg";
import Play from "../../assets/icons/ui/play.svg";
import Plus from "../../assets/icons/ui/plus.svg";
import Redo from "../../assets/icons/ui/redo.svg";
import Reply from "../../assets/icons/ui/reply.svg";
import Search from "../../assets/icons/ui/search.svg";
import Send from "../../assets/icons/ui/send.svg";
import Share from "../../assets/icons/ui/share.svg";
import Sparkle from "../../assets/icons/ui/sparkle.svg";
import Star from "../../assets/icons/ui/star.svg";
import StarFilled from "../../assets/icons/ui/star-filled.svg";
import ThumbDown from "../../assets/icons/ui/thumb-down.svg";
import ThumbUp from "../../assets/icons/ui/thumb-up.svg";
import Trash from "../../assets/icons/ui/trash.svg";
import Undo from "../../assets/icons/ui/undo.svg";

/**
 * Ported from apps/web/src/web/Icon.tsx's `ICONS` map. The web version maps
 * icon keys to file path STRINGS, fetched at runtime and painted through a
 * CSS `mask-image` so any element's `currentColor` shows through the
 * shape — see that file's module comment for why a mask rather than
 * `<img>`. Metro has no runtime string-to-asset lookup: every `.svg` has to
 * be a static `import` for the bundler to see it at all, so this map holds
 * component references instead of path strings.
 *
 * Every source SVG under assets/icons was recoloured on copy (`#000` ->
 * `currentColor`) specifically so this works: react-native-svg resolves
 * `currentColor` inside an SVG from the `color` prop passed to the
 * component, which is the native equivalent of the web version's CSS
 * `currentColor` cascade — see Icon() below.
 */
export const ICONS = {
  arrowUp: ArrowUp,
  bell: Bell,
  bellMuted: BellMuted,
  chat: Chat,
  check: Check,
  chevronLeft: ChevronLeft,
  close: Close,
  comment: Comment,
  copy: Copy,
  eraser: Eraser,
  feed: Feed,
  heart: Heart,
  download: Download,
  image: ImageIcon,
  heartFilled: HeartFilled,
  locate: Locate,
  lock: Lock,
  map: MapIcon,
  minimize: Minimize,
  more: More,
  block: Block,
  people: People,
  personAdd: PersonAdd,
  personRemove: PersonRemove,
  place: Place,
  plus: Plus,
  play: Play,
  redo: Redo,
  reply: Reply,
  search: Search,
  send: Send,
  share: Share,
  sparkle: Sparkle,
  star: Star,
  starFilled: StarFilled,
  thumbUp: ThumbUp,
  thumbDown: ThumbDown,
  trash: Trash,
  undo: Undo,
} as const satisfies Record<string, FC<SvgProps>>;

export type IconName = keyof typeof ICONS;

interface IconProps {
  /** One of `ICONS`, or a category icon component from `lookOf` (see theme/categories.ts). */
  src: FC<SvgProps>;
  /** Rendered box, in density-independent pixels. The art is square and scales to fit. */
  size?: number;
  /**
   * Resolves every `currentColor` in the SVG — the direct equivalent of the
   * web version inheriting CSS `currentColor` from its container. Unlike
   * CSS, RN has no colour cascade, so this is required rather than
   * optional; there is no sensible default that would be right most of the
   * time across every call site.
   */
  color: string;
}

/**
 * A square icon, recoloured to `color`. Decorative by default — matches the
 * web version's `aria-hidden="true"`, since every call site sits next to a
 * text label or inside a control that already carries its own accessible
 * name.
 */
export function Icon({ src: Svg, size = 18, color }: IconProps) {
  return <Svg width={size} height={size} color={color} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />;
}
