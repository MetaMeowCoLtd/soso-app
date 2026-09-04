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
  // Next emits the modern `mobile-web-app-capable` tag from `appleWebApp`,
  // but recent static builds do not reliably emit this legacy Apple tag.
  // iOS still uses it to decide whether a Home Screen web app may draw below
  // the status bar/notch when `black-translucent` is requested.
  other: {
    "mobile-web-app-capable": "yes",
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
          with viewport-fit=cover that value often excludes the Home Indicator,
          which is exactly the empty background strip at the bottom. Height is
          handled in CSS via inset:0 and -webkit-fill-available.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){
  function setAppOffset(){
    var vv = window.visualViewport;
    var top = vv ? vv.offsetTop : 0;
    var left = vv ? vv.offsetLeft : 0;
    document.documentElement.style.setProperty('--app-top', top + 'px');
    document.documentElement.style.setProperty('--app-left', left + 'px');
    // How much of the layout viewport's bottom edge the on-screen keyboard
    // currently covers. body itself is deliberately NOT resized for this
    // (see the comment above — that would reintroduce the Home Indicator
    // gap this same script exists to avoid), so this is applied narrowly,
    // in CSS, only to the specific fixed-bottom inputs that actually need
    // to stay above the keyboard (.chat-compose) rather than to the shell.
    var keyboardInset = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
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
