import type { Metadata, Viewport } from "next";
import "leaflet/dist/leaflet.css";
import "maplibre-gl/dist/maplibre-gl.css";
import "./globals.css";

const basePath = process.env.NEXT_BASE_PATH ?? "";

export const metadata: Metadata = {
  title: "Soso | Local reports, simply shared",
  description: "A local-first incident reporting MVP.",
  manifest: `${basePath}/manifest.webmanifest`,
  icons: { icon: `${basePath}/soso-icon.svg`, apple: `${basePath}/soso-icon.svg` },
  appleWebApp: { capable: true, title: "Soso", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  themeColor: "#0f766e",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
