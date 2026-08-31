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
  // not an arbitrary brand color. On iOS this value is what Safari paints
  // into the safe-area strip around its toolbar before the page's own
  // 100dvh layout has settled — which on cold launch (toolbar starts
  // expanded, then collapses on first scroll/drag) is a real, visible
  // window, not a hypothetical edge case. A mismatched theme-color shows up
  // there as an obvious stray bar at the bottom; a matching one just looks
  // like part of the page loading normally. If the page background ever
  // changes, update this alongside it (and public/manifest.json's
  // theme_color, which needs the same value for the installed-PWA case).
  themeColor: "#bcd9d2",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        {/*
          The real fix for the iOS gap, not just the color-matching one.

          `100dvh` is *supposed* to always equal the current visible
          viewport, live-updating as Safari's toolbar expands/collapses. In
          practice, on a cold launch, WebKit does not always recompute it
          correctly on the very first layout pass — it settles into the
          right value only once something (a scroll, a toolbar drag) forces
          a fresh resize. Until then, `.map-app`'s `height:100dvh` can be
          taller than what's actually drawn, leaving a real, empty strip at
          the bottom — not a color mismatch, an actual unfilled gap.

          `window.visualViewport` does not have this bug: it reports the
          true current visible height immediately and fires `resize` on
          every toolbar change. This script mirrors that value into a CSS
          custom property the moment it's known, and `.map-app` in
          globals.css reads `var(--app-height, 100dvh)` — falling back to
          the CSS unit only for the one frame before this runs, and on any
          browser without visualViewport support at all.

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
