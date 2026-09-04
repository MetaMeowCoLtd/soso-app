import type { Metadata, Viewport } from "next";
import "leaflet/dist/leaflet.css";
import "maplibre-gl/dist/maplibre-gl.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "SoSo",
  description: "A map-centric social network service",
  // A relative path, not "/manifest.json" — this deploys under a variable
  // GitHub Pages subpath (see NEXT_BASE_PATH in next.config.ts), and a
  // relative reference resolves correctly against the page's own URL either
  // way, with no basePath templating needed.
  manifest: "manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "SoSo",
  },
  icons: {
    icon: [
      // Relative paths, same reasoning as `manifest` above: this deploys
      // under a variable GitHub Pages subpath, so a leading "/" would
      // resolve to the wrong place. favicon.ico is Next's own multi-res
      // fallback for browsers/crawlers that fetch /favicon.ico directly
      // regardless of these tags; the PNGs are what browsers that do read
      // <link rel="icon"> actually render in the tab.
      { url: "favicon.ico", sizes: "16x16 32x32 48x48" },
      { url: "icons/favicon-16.png", sizes: "16x16", type: "image/png" },
      { url: "icons/favicon-32.png", sizes: "32x32", type: "image/png" },
    ],
    apple: "icons/apple-touch-icon.png",
  },
  // Next emits the modern `mobile-web-app-capable` tag from `appleWebApp`
  // above, but not this legacy Apple-prefixed one — check `out/index.html`
  // after a build and you'll find `mobile-web-app-capable` twice and
  // `apple-mobile-web-app-capable` not at all. iOS still reads ONLY the
  // Apple-prefixed name when deciding whether a Home Screen web app may draw
  // below the status bar and above the Home Indicator, and
  // `apple-mobile-web-app-status-bar-style: black-translucent` (set via
  // `appleWebApp.statusBarStyle`) is ignored outright without it.
  other: {
    "apple-mobile-web-app-capable": "yes",
  },
};

export const viewport: Viewport = {
  // Matches the app's actual background (html/body/.map-app in globals.css),
  // not an arbitrary brand color — a belt-and-suspenders fallback for the
  // one frame before the script below runs, and for browsers without
  // `visualViewport` at all. On its own it does not fix the actual gap; see
  // that script for the fix that does.
  themeColor: "#bcd9d2",
  width: "device-width",
  initialScale: 1,
  // Disables native pinch/double-tap zoom on the page chrome (buttons, the
  // composer sheet, the people panel) without touching the map's own zoom:
  // Leaflet implements pinch-to-zoom itself, via its own touch-event
  // handlers on the map container (see `touchZoom` on <MapContainer> in
  // SosoMap.tsx, on by default) — it does not use or depend on the
  // browser's native page-zoom gesture at all, so restricting THAT gesture
  // at the page level has no effect on the map's zoom. This also removes
  // one more way the outer page could end up temporarily larger than the
  // viewport (a stray double-tap zooming the whole page), which is the
  // same family of problem `position:fixed` in globals.css exists to close.
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <head>
        {/*
          Pins the fixed body to the visual viewport's offset (iOS can leave
          offsetTop/offsetLeft non-zero after a cold PWA launch, and with
          user-scalable=no the user can no longer drag to correct it).

          Do NOT size the shell from visualViewport.height: on iOS Home Screen
          with viewport-fit=cover that value excludes the Home Indicator, which
          is exactly the empty background strip this used to leave at the
          bottom. -webkit-fill-available and 100dvh are short in the same way
          and for the same reason — see the html/body comment in globals.css.
          Height is handled there, by body's inset alone.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){
  // Established once, before any input is ever focused (this script's own
  // initial call and its 100/400/1000ms follow-ups all run long before a
  // real person could have tapped a text field), and only ever revised
  // upward from there. This exists because window.innerHeight cannot be
  // trusted moment-to-moment as "the true full-screen height" on an
  // installed iOS Home Screen PWA specifically: the first time the on-screen
  // keyboard opens in a session, window.innerHeight (and
  // visualViewport.height, and 100dvh) drop to the keyboard-open size and,
  // per widely-reported iOS behaviour, do not reliably return to the full
  // value afterwards even once the keyboard closes. A formula that
  // subtracts the CURRENT innerHeight from the current visual viewport
  // height — the textbook way to size a keyboard from visualViewport, and
  // what this script used to do — silently breaks the moment that happens:
  // both sides of the subtraction have shrunk by roughly the same amount,
  // so the difference comes out near zero regardless of how much of the
  // screen the keyboard actually covers. Keeping our own independently
  // tracked maximum sidesteps this entirely, since it never trusts
  // window.innerHeight's CURRENT value as the baseline, only ever the
  // largest one this session has ever actually observed.
  var maxViewportHeight = window.innerHeight;
  function setAppOffset(){
    var vv = window.visualViewport;
    var top = vv ? vv.offsetTop : 0;
    var left = vv ? vv.offsetLeft : 0;
    document.documentElement.style.setProperty('--app-top', top + 'px');
    document.documentElement.style.setProperty('--app-left', left + 'px');
    maxViewportHeight = Math.max(maxViewportHeight, window.innerHeight);
    // How much of the layout viewport's bottom edge the on-screen keyboard
    // currently covers. body itself is deliberately NOT resized for this
    // (see the comment above — that would reintroduce the Home Indicator
    // gap this same script exists to avoid), so this is applied narrowly,
    // in CSS, only to the specific fixed-bottom inputs that actually need
    // to stay above the keyboard (.chat-compose) rather than to the shell.
    var visualHeight = vv ? vv.height : window.innerHeight;
    var keyboardInset = vv ? Math.max(0, maxViewportHeight - visualHeight - top) : 0;
    // A separately-documented iOS quirk (visualViewport.offsetTop sometimes
    // not resetting cleanly to 0 right after the keyboard is dismissed) can
    // otherwise leave a few stray pixels of residual inset behind even with
    // the fix above. Below this threshold there is no keyboard actually
    // open — round it down to a clean 0 rather than leaving a sliver of
    // unwanted margin under the compose bar for the rest of the session.
    if (keyboardInset < 4) keyboardInset = 0;
    document.documentElement.style.setProperty('--keyboard-inset', keyboardInset + 'px');
    if (top || left) window.scrollTo(0, 0);
  }
  setAppOffset();
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', setAppOffset);
    window.visualViewport.addEventListener('scroll', setAppOffset);
  }
  window.addEventListener('resize', setAppOffset);
  window.addEventListener('orientationchange', function(){
    setAppOffset();
    setTimeout(setAppOffset, 300);
  });
  [100, 400, 1000].forEach(function(ms){ setTimeout(setAppOffset, ms); });
})();`,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
