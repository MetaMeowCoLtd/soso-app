import type { Metadata, Viewport } from "next";
import "leaflet/dist/leaflet.css";
import "maplibre-gl/dist/maplibre-gl.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Soso | Local reports, simply shared",
  description: "A local-first incident reporting MVP.",
  // A relative path, not "/manifest.json" — this deploys under a variable
  // GitHub Pages subpath (see NEXT_BASE_PATH in next.config.ts), and a
  // relative reference resolves correctly against the page's own URL either
  // way, with no basePath templating needed.
  manifest: "manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Soso",
  },
  icons: {
    apple: "icons/apple-touch-icon.png",
  },
  // Next emits the modern `mobile-web-app-capable` tag from `appleWebApp`,
  // but recent static builds do not reliably emit this legacy Apple tag.
  // iOS still uses it to decide whether a Home Screen web app may draw below
  // the status bar/notch when `black-translucent` is requested.
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
          Pins the app shell to the height iOS actually reports, rather than
          to a CSS unit.

          Why this exists despite the CSS already using a 100% /
          -webkit-fill-available / 100dvh fallback chain: those units are
          resolved by the engine against ITS idea of the viewport, and on a
          cold iOS PWA launch that idea is briefly wrong — the safe-area
          insets settle after first paint, and nothing re-resolves a CSS unit
          afterwards. `visualViewport.height` is the one value that reports
          the real, current visible height, and it fires an event when that
          changes. Setting a custom property from it means the layout follows
          the actual viewport rather than a prediction of it.

          Runs before hydration (inline in <head>) so the first painted frame
          already has the correct height, rather than visibly correcting a
          wrong one a moment later.

          The `scroll` listener is not redundant with `resize`: iOS fires
          scroll on the visual viewport when the keyboard opens or the page
          is panned under a pinned element, without necessarily firing resize.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){
  function setAppHeight(){
    var vv = window.visualViewport;
    var h = vv ? vv.height : window.innerHeight;
    document.documentElement.style.setProperty('--app-height', h + 'px');
  }
  setAppHeight();
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', setAppHeight);
    window.visualViewport.addEventListener('scroll', setAppHeight);
  }
  window.addEventListener('resize', setAppHeight);
  window.addEventListener('orientationchange', function(){
    setAppHeight();
    setTimeout(setAppHeight, 300);
  });
  [100, 400, 1000].forEach(function(ms){ setTimeout(setAppHeight, ms); });
})();`,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
