import type { NextConfig } from "next";

// Set only in the GitHub Pages workflow, to the repo name (e.g. "/soso") when
// this deploys as a project page rather than a username.github.io root page.
// Left empty, everything below is a no-op and `npm run dev` / `npm run build`
// behave exactly as before — this file has no effect unless you're deploying
// to Pages.
const basePath = process.env.NEXT_BASE_PATH ?? "";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // packages/core ships TypeScript source, not a pre-built dist — Next needs
  // to run its own compiler over it rather than treating it as an opaque,
  // already-compiled dependency the way it treats ordinary node_modules.
  transpilePackages: ["soso-core"],

  // Static export: every Supabase call in this app already happens in the
  // browser (see src/web/supabase.ts and demo-gateway.ts) — there are no
  // server components doing data fetching, no route handlers, no server
  // actions. That's what makes `output: "export"` possible at all: Next has
  // nothing server-side to give up. This produces a plain folder of HTML/JS/
  // CSS in apps/web/out that any static host, including GitHub Pages, can
  // serve as-is.
  output: "export",
  basePath,
  assetPrefix: basePath ? `${basePath}/` : undefined,
  // Browser code needs the same base path to register `/repo/sw.js` on a
  // GitHub project page instead of accidentally registering `/sw.js`.
  env: { NEXT_PUBLIC_BASE_PATH: basePath },
  // The image optimizer needs a running server; static export has none.
  // Irrelevant today (nothing uses next/image yet) but left in place so
  // adding an image later doesn't silently break the Pages build.
  images: { unoptimized: true },
};

export default nextConfig;
