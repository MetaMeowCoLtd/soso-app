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
  // not an arbitrary brand color — kept from the earlier pass at this bug.
  // It's a reasonable belt-and-suspenders fallback for a moment before the
  // page's own background has painted, but it did NOT fix the actual gap on
  // its own (confirmed by shipping it alone first) — see globals.css for
  // the fix that did: locking html/body to the viewport with
  // `position:fixed` so the outer document can never overscroll/bounce.
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
  // same family of problem as the overscroll fix in globals.css.
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
