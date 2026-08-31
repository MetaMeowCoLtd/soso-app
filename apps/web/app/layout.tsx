import type { Metadata, Viewport } from "next";
import Script from "next/script";
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
      <body>
        {/*
          The actual fix for the iOS standalone-launch gap at the bottom of
          the screen — not just the theme-color belt-and-suspenders above.

          `100dvh` is *supposed* to always equal the current visible
          viewport. In practice, on a cold launch of the installed
          (`apple-mobile-web-app-capable`) app, WebKit does not always
          resolve it correctly on the very first layout pass — it settles
          into the right value only once something (a scroll, a resize)
          forces a fresh recompute. Until then, `.map-app`'s height can be
          shorter than the true visible area, leaving a real, empty strip at
          the bottom — not a color mismatch, an actual unfilled gap.

          `window.visualViewport` doesn't have this bug: it reports the true
          current visible height immediately and fires `resize` on every
          change. This mirrors that value into a CSS custom property the
          moment it's known, and `.map-app` in globals.css reads
          `var(--app-height, 100dvh)` — falling back to the CSS unit only for
          the one frame before this runs, and on any browser without
          `visualViewport` support at all.

          This is independent of, and sits alongside, the `position:fixed`
          scroll lock on html/body in globals.css: that stops the page from
          *scrolling*; this fixes the *sizing* of `.map-app` on first paint.
          Losing either one reintroduces a bottom-of-screen gap, just from a
          different cause — this exact mechanism was accidentally dropped
          once already (see the `position:fixed` commit's diff, which
          rewrote this file for the zoom lock and lost it as a side effect)
          and reappeared as "the bottom bar never goes away" in standalone
          mode. Don't remove this again without keeping something equivalent.

          `beforeInteractive` is required, not `afterInteractive`: this has
          to set the property before the first paint the user sees, or the
          gap flashes once anyway and this becomes a no-op.
        */}
        <Script id="app-height-fix" strategy="beforeInteractive">
          {`
            (function () {
              function setAppHeight() {
                var vv = window.visualViewport;
                var h = (vv && vv.height) || window.innerHeight;
                document.documentElement.style.setProperty("--app-height", h + "px");
              }
              setAppHeight();
              if (window.visualViewport) {
                window.visualViewport.addEventListener("resize", setAppHeight);
                window.visualViewport.addEventListener("scroll", setAppHeight);
              }
              window.addEventListener("resize", setAppHeight);
              window.addEventListener("orientationchange", setAppHeight);
            })();
          `}
        </Script>
        {children}
      </body>
    </html>
  );
}
