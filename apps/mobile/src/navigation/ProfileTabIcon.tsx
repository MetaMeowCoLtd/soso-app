import { useEffect, useState } from "react";

import { useGateway } from "../gate/AppGate";
import { Avatar } from "../ui/Avatar";

/**
 * The Profile tab's icon is the signed-in person's own avatar, not a
 * generic glyph — there's no plain "person" icon among the ~39 ported UI
 * SVGs (only `people`, already owned by the People tab, and `personAdd`/
 * `personRemove`, which carry a +/- badge that would misread as an action
 * rather than a tab). The web app's own tab bar has a `.tab-bar-avatar`
 * class for exactly this; this is that, not an invented substitute.
 *
 * Fetches just the avatar path via `myProfile()` — the same call
 * ProfileTabScreen makes for its own handle resolution, kept independent
 * here rather than shared, since a tab icon has no reason to depend on
 * whichever screen happens to be focused.
 */
export function ProfileTabIcon({ size }: { size: number }) {
  const gateway = useGateway();
  const [avatarSrc, setAvatarSrc] = useState<string | null>(null);
  const [name, setName] = useState("You");

  useEffect(() => {
    let cancelled = false;
    gateway.myProfile().then((profile) => {
      if (cancelled || !profile) return;
      setName(profile.displayName);
      setAvatarSrc(gateway.avatarUrl(profile.avatarPath));
    });
    return () => {
      cancelled = true;
    };
  }, [gateway]);

  return <Avatar name={name} src={avatarSrc} size={size} />;
}
