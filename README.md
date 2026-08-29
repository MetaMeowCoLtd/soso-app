# Soso

Soso is a location-first social platform for practical local reporting: what's
happening right now, at a specific place, until it isn't relevant anymore.
Every post — an accident, a lane closure, a lost wallet, a table opening up —
is modelled the same way: **something is true, at a place, until a time.** That
one idea is what makes expiry, per-category lifetimes, and a small working set
fall out of the schema instead of being bolted on.

This repository is the web MVP: a Next.js + Leaflet map backed by Supabase.

> This is a development-stage application, not an emergency service. For
> immediate danger, use local emergency services.

## What it is

- A full-screen map. Click anywhere to drop a pin; click an existing pin (or a
  row in the local-buzz drawer) to see its detail and confirm or dispute it.
- Reports carry a server-assigned lifetime and disappear on their own —
  nothing needs to be manually marked "resolved."
- Every category's rules — how long a post lives, whether it needs a
  description, whether the poster has to actually be there — are configured in
  the database, not in application code. Enabling or retiring a category is a
  data change, not a deploy.
- Runs with **no Supabase project at all**: if the backend is unreachable or
  unconfigured, the app falls back to a local demo mode automatically. See
  [Demo mode](#demo-mode) below.

## Features and their status

| Feature | Status |
| --- | --- |
| Map with click-to-report | Implemented |
| Incident reporting (accident, hazard, crowding, outage) | Implemented |
| Construction / closures | Implemented |
| Lost & found | Implemented |
| Seat availability (restaurant/cafe) | Implemented |
| Per-category expiry (TTL) | Implemented — server-assigned, client cannot extend it |
| Server-side validation (proximity, rate limits, body length, subtype) | Implemented — enforced in Postgres, not just the form |
| Corroboration ("still here" / "not true") and auto-hide on disputes | Implemented |
| Reporting a post (flagging for review) | Implemented — accepted, no moderator workflow behind it yet |
| Local demo mode (no backend required) | Implemented |
| Polls ("where should we eat tonight?") | Modelled, disabled — needs its own options/votes tables |
| Local news / official notices | Modelled, disabled |
| Topic groups | Not built |
| Harassment reporting | Modelled, **shipped disabled** — needs legal review before it can go live; see the comment in `supabase/seed.sql` |
| Photo uploads | Not built (`post_media` table exists, nothing writes to it) |
| Push notifications for new pins | Implemented — standards-based Web Push; opt-in per browser installation, excludes the author |
| Early resolution (e.g. "seats just filled up," before the TTL expires) | Not built — everything currently expires only via TTL |
| Native iOS/Android app | Not currently in this repo — see [About the mobile app](#about-the-mobile-app) |

## Platforms

**Web (this repo, primary target).** Next.js 15 + React 19 + Leaflet, in
`apps/web`. Runs in any modern desktop or mobile browser. This is the fast
iteration surface: no build queue, no store review, no native toolchain.

**iOS / Android.** Not present in this repository right now. An earlier pass
built a working Expo + `react-native-maps` app against the same backend, and
it worked — typechecked, tested, built — but it's been removed rather than
maintained alongside a web app that's still actively changing shape. The
architecture that made that possible is still here and unchanged:

- `packages/core` (domain logic, the `SosoGateway` port, the Supabase adapter,
  the polling feed controller) has zero React, zero DOM, and zero React Native
  in it. It's plain TypeScript.
- Every platform-specific thing — the map component, hooks, the demo-mode
  fallback — lives under that platform's own `apps/*` folder and consumes
  `packages/core` as its only shared dependency.

Rebuilding the mobile app later means creating `apps/mobile` and writing a
map/composer/detail view against the same `SosoGateway` interface `apps/web`
already uses — not re-deriving the schema, the validation rules, or the
polling strategy. See [Adding a native app later](#adding-a-native-app-later).

## Prerequisites

- **Node.js 20 or later.** Check with `node --version`.
- **A Supabase account** (free tier is enough) — optional. Without one, the
  app runs in local demo mode; see below.
- **The Supabase CLI**, only if you want to run the real backend locally
  instead of a hosted project: [supabase.com/docs/guides/cli](https://supabase.com/docs/guides/cli).

## Build and run

If you're starting from a downloaded/unzipped copy of this project rather than
an existing GitHub repo, do this first — skipping it is exactly what produces
a repo with no `.github` folder and a CI run that fails looking for a lockfile
that was never committed:

```bash
cd soso                 # the folder containing this README
git init
git branch -M main
npm install              # generates package-lock.json — required for CI, see below
git add -A                # -A, not a GUI drag-and-drop: dotfolders like .github/
                           # are commonly hidden by OS file pickers and silently
                           # left out if you drag a folder in instead
git commit -m "Initial commit"
git remote add origin https://github.com/<you>/<your-repo>.git
git push -u origin main
```

`npm ci` in the GitHub Actions workflow (below) hard-requires
`package-lock.json` to be committed — without it, CI fails immediately with a
"Dependencies lock file is not found" error, before anything of yours even
runs. It only needs regenerating (`npm install` again, then commit) when a
dependency changes; ordinary code edits don't touch it.

If you already have this in a git repo, skip straight to:

```bash
npm install
```

That one `npm install` covers `packages/core` and `apps/web` together — they
share a single npm workspace (see [Why the workspace only has two
members](#why-the-workspace-only-has-two-members)).

### Run without a backend (fastest path)

```bash
npm run dev
```

Open `http://localhost:3000`. With no `.env.local`, the app drops straight
into demo mode — a few seeded reports near Tokyo Station, fully interactive,
persisted to your browser's `localStorage`. Good enough to look at the whole
interaction loop in under a minute.

### Run against a real Supabase backend

There are two separate paths here, and they use different commands —
`supabase db reset` only ever touches a **local** Docker-based stack; it has
no way to reach a hosted project at all.

**Local, via `supabase start`:**

1. `supabase start` (requires Docker running).
2. `npm run db:reset` — applies every file in `supabase/migrations/` in
   order, then `supabase/seed.sql`, against the local instance.
3. Point `apps/web/.env.local` at the local URL/anon key `supabase start`
   prints out.

**Hosted, which is what GitHub Pages needs:**

1. Create a project at supabase.com if you don't have one yet. You'll need
   its **project ref** (the subdomain in its URL — `abcdefgh` in
   `https://abcdefgh.supabase.co`) and its **database password** (set at
   creation, resettable under Settings → Database).
2. Install the Supabase CLI if it isn't already (`brew install
   supabase/tap/supabase` on macOS), then:

   ```bash
   supabase login
   supabase link --project-ref <your-project-ref>
   supabase db push --include-seed
   ```

   `link` connects this local checkout to that specific hosted project.
   `db push --include-seed` applies every file in `supabase/migrations/` in
   order — including the RLS policies (see [The architecture,
   briefly](#the-architecture-briefly) for why those aren't a separate step)
   — then `supabase/seed.sql`, which is the actual product configuration:
   every category's TTL, proximity rule, and body limit is a row there, not
   a line of application code. This is the same schema, run against the
   hosted database instead of a local one.

   One thing worth knowing about `--include-seed`: it only runs the seed file
   alongside a migration it's actually applying. If you edit `seed.sql` later
   with no new migration to go with it, `db push --include-seed` reports
   "up to date" and skips the seed step — running the seed SQL again at that
   point means pasting it into the Supabase dashboard's SQL Editor directly,
   or adding a trivial new migration to give `push` something to apply.

3. If the `postgis` extension fails to enable during the push, enable it
   manually first under Database → Extensions in the dashboard, then push
   again.
4. Copy `apps/web/.env.local.example` to `apps/web/.env.local` and fill in
   that project's URL and anon key (Supabase dashboard → Settings → API).
5. In the Supabase dashboard, enable **Authentication → Providers →
   Anonymous** — the app signs users in anonymously so posting doesn't need a
   signup flow yet (see [Known gaps](#known-gaps) for why that's temporary).
6. `npm run dev` again, or push to trigger the GitHub Pages workflow if
   you're deploying rather than running locally.

If any of that is misconfigured or unreachable, you'll silently get demo mode
back rather than a broken page — see the next section.

## Enable push notifications

Soso uses **standards-based Web Push**, not a native mobile SDK. A person taps
**Enable alerts** in the Soso header; only then does the browser show its own
permission prompt. If they approve, the browser gives Soso an encrypted push
subscription. When someone else adds a pin, Supabase sends a generic, privacy-
preserving notification to that subscription even if the app is closed.

The notification intentionally says only that a category of pin was added. It
does not contain the post body, author, address, or precise location because
notifications can be visible on a locked screen. The person who posted a pin
is always excluded from delivery for that pin.

### Platform requirements for testers

- **Desktop:** Current Chrome, Edge, Firefox, and Safari support browser
  notifications. Open the deployed HTTPS site and select **Enable alerts**.
- **Android:** In Chrome, install Soso using the browser’s **Install app** or
  **Add to Home screen** action, open that installed app, and select **Enable
  alerts**.
- **iPhone/iPad:** Requires iOS/iPadOS 16.4 or later. Open the deployed site
  in **Safari** (not an in-app browser), tap **Share → Add to Home Screen**,
  open Soso from its new home-screen icon, then select **Enable alerts**. iOS
  will not show the Web Push permission prompt from an ordinary Safari tab.

`localhost` is useful for UI work but not for cross-device push tests. Use a
real HTTPS deployment, such as GitHub Pages, before testing notifications.

### One-time project setup

Run these commands from the repository root after you have linked your hosted
Supabase project as described above.

1. Apply the included migration, which creates the private subscription table
   and client-safe subscribe/unsubscribe RPCs:

   ```bash
   supabase db push
   ```

2. Generate one VAPID key pair. Keep the private key out of Git, browser
   variables, and GitHub Actions variables:

   ```bash
   npx --yes web-push generate-vapid-keys --json
   ```

   Save the `publicKey` and `privateKey` values it prints. VAPID identifies
   Soso to the browser push services; the same pair must remain in use while
   subscriptions exist.

3. Create a webhook secret and set the server-only Edge Function secrets. Use
   your own email in the VAPID subject:

   ```bash
   openssl rand -hex 32
   supabase secrets set \
     VAPID_PUBLIC_KEY='<publicKey>' \
     VAPID_PRIVATE_KEY='<privateKey>' \
     VAPID_SUBJECT='mailto:you@example.com' \
     WEBHOOK_SECRET='<random-value-from-openssl>'
   ```

4. Deploy the notification function. `--no-verify-jwt` is intentional: this
   endpoint receives a database webhook rather than a user session, and it
   authenticates every request using `X-Soso-Webhook-Secret` instead.

   ```bash
   supabase functions deploy notify-new-pin --no-verify-jwt
   ```

5. In the Supabase dashboard, go to **Database → Webhooks → Create a new
   webhook** and enter:

   | Field | Value |
   | --- | --- |
   | Name | `notify-new-pin` |
   | Table | `public.posts` |
   | Events | `Insert` only |
   | HTTP method | `POST` |
   | URL | `https://<project-ref>.supabase.co/functions/v1/notify-new-pin` |
   | Header | `X-Soso-Webhook-Secret: <the-random-value-from-step-3>` |

   Save the webhook. Never place the Supabase `service_role` key in the
   browser, GitHub, or the webhook header; the Edge Function already receives
   it as a server-side secret.

6. Add the VAPID **public** key to your app configuration:

   ```text
   # apps/web/.env.local — local development only
   NEXT_PUBLIC_VAPID_PUBLIC_KEY=<publicKey>
   ```

   For GitHub Pages, add `NEXT_PUBLIC_VAPID_PUBLIC_KEY` as a repository
   **variable**, next to the existing `NEXT_PUBLIC_SUPABASE_URL` and
   `NEXT_PUBLIC_SUPABASE_ANON_KEY` variables, then trigger a new deployment.
   The public key is safe to ship; only the private key must remain in
   Supabase secrets.

7. Open the deployed app on two different browser installations. In the first,
   install it to the home screen if you are on mobile, then select **Enable
   alerts** and approve permission. In the second, add a pin. The first should
   receive a notification. The poster should not.

### Troubleshooting push

- **No Enable alerts button:** the app is in demo mode, the public VAPID key
  is missing, or the browser does not support Web Push. Confirm the three
  `NEXT_PUBLIC_SUPABASE_*`/`NEXT_PUBLIC_VAPID_PUBLIC_KEY` values are present
  in the deployed build.
- **iPhone does not prompt:** make sure the site was added to the Home Screen
  from Safari, then open the home-screen app before tapping Enable alerts.
- **Button says Alerts blocked:** change the notification permission in that
  browser’s website settings, then reload Soso.
- **Subscription works but no delivery:** inspect the `notify-new-pin` Edge
  Function logs in Supabase. The usual causes are a missing Edge Function
  secret, wrong webhook URL/header, or a webhook that is not limited to the
  `INSERT` event.
- **Works once then stops:** a browser may rotate or invalidate its push
  endpoint. Soso deletes 404/410 endpoints automatically; the person can
  simply enable alerts again.

### Tests and typechecking

```bash
npm test         # packages/core — 46 tests, pure logic, no database needed
npm run typecheck # packages/core and apps/web together
npm run build     # production build of apps/web
```

Nothing in `packages/core`'s test suite touches a network or a database. The
SQL itself is validated for syntax with a real Postgres parser as part of
development, but **has not been executed against a live instance** — running
`npm run db:reset` against a real project is the first real test of it. Budget
for fixing something on that first run.

## Demo mode

`apps/web/src/web/bootstrap.ts` decides once, at startup, which backend to
use. If `NEXT_PUBLIC_SUPABASE_URL` / `..._ANON_KEY` are missing, or a
connection attempt to them fails or times out (6 seconds), it falls back to
`apps/web/src/web/demo-gateway.ts` — a second, complete implementation of the
exact same `SosoGateway` interface the real Supabase adapter implements,
backed by `localStorage` instead of Postgres.

Every screen in the app is written against that interface and has no idea
which implementation answered it. That's the reason this was cheap to add:
the port/adapter split wasn't done in anticipation of a demo mode
specifically, but it's exactly the kind of thing that split is for.

What demo mode gets right:

- The same five enabled categories, with the same TTLs, proximity radii, body
  limits, and subtypes — hand-mirrored from `supabase/seed.sql` (see the
  warning comment at the top of `demo-gateway.ts`: there's nothing keeping
  these two in sync automatically).
- The same corroboration/auto-hide rule (3+ disputes, outnumbering
  confirmations more than 2:1, hides a post).
- The same validation error codes, so the UI's error messages don't diverge
  between modes.

What it deliberately doesn't get right:

- **It is not a security boundary.** The real backend's rules are enforced in
  Postgres, where the browser can't touch them. Demo mode's rules run in the
  browser the user controls — anyone with devtools open can bypass every one
  of them. That's fine, because demo mode only ever touches that one browser's
  own local storage; there's no shared data to protect.
- **No location fuzzing runs in practice.** The five enabled categories all
  have `locationPrecisionM = 0`, so this never triggers today even though the
  code path exists for parity with `create_post`.
- **A backend that goes down mid-session isn't detected.** The gateway is
  resolved once, at startup, and held for the life of the tab. If Supabase was
  reachable when the page loaded and then goes away, the app doesn't notice or
  fall back — that would need a circuit breaker re-testing connectivity and
  swapping the gateway under a live feed controller, which is a real feature,
  not a fallback.

## The architecture, briefly

```
packages/core/     Domain logic, the SosoGateway port, the Supabase adapter,
                    the incremental-fetch feed controller. Pure TypeScript —
                    no React, no DOM, no platform code. Tested in isolation.
apps/web/           Next.js + Leaflet. Owns everything platform-specific:
                    the map component, React hooks, the demo-mode fallback.
supabase/           The schema. migrations/ is the mechanism; seed.sql is the
                    product spec — read it to see what each category actually
                    does.
```

**One `posts` table, configuration in a table, not branches in code.** An
incident, a lost wallet, and a seat-availability note are the same underlying
object with different rows in `post_categories`. Adding a category is an
`INSERT`. Disabling one during a legal review is an `UPDATE`. See the extended
comments in `supabase/migrations/20260828000003_core.sql` and `seed.sql`.

**Writes go through `SECURITY DEFINER` functions, not RLS insert policies.**
`create_post` is where TTL clamping, proximity checks, rate limits, and body
length all run together, in one place, with error codes the client can
actually branch on. A client cannot write a post directly — that's
deliberate, and it's what "server-side validation" concretely means here: the
web form doesn't duplicate these rules, it just submits and displays whatever
the server decides. See `supabase/migrations/20260828000005_api.sql`.

**RLS policies are ordinary migration SQL, not a separate artifact.** They
live in `supabase/migrations/20260828000004_rls.sql`, alongside the tables
and functions in the other five files, and `supabase db push` applies all six
in one sequence — there's no separate command or Dashboard step to "push
policies." The Dashboard's Authentication → Policies tab is a *view* onto
what's already in Postgres, not an alternate way to manage them. Changing a
policy means writing a new migration (`drop policy ...; create policy ...`,
since Postgres has no `create policy if not exists`) and pushing again —
editing a policy directly in the Dashboard changes the live database without
updating the migration file, which immediately puts the repo and the hosted
project out of sync.

**The feed is polled incrementally, not refetched.** `feed_delta` takes a
cursor and returns only what changed since it, plus a tombstone list for
anything that stopped being live. A quiet viewport costs about 150 bytes per
poll instead of tens of kilobytes. This is also why pins expire automatically
in the UI with no extra request: every pin already carries its own
`expiresAt`, and the client stops drawing it once that passes.

## Why the workspace only has two members

`packages/core` and `apps/web` share one npm workspace and one `node_modules`.
A React Native app does not belong in that same install: React Native and
Next.js need incompatible major versions of `react`/`react-dom`, and npm's
hoisting produces a broken tree when asked to satisfy both at once — a
mismatched `react`/`react-dom` pair at the workspace root, which is a
structural incompatibility between the two toolchains, not something a
version pin fixes. If `apps/mobile` comes back, it should get its **own**
`npm install`, consuming `packages/core` the same way it did before removal:
plain relative filesystem imports into `packages/core/src`, which need no
workspace symlink or module resolution at all.

## Adding a native app later

The interface to build against is `SosoGateway` in
`packages/core/src/data/gateway.ts` — five methods: load categories, an
incremental feed fetch, per-cell counts, post detail, and the four writes
(create, vote, report). `apps/web`'s `SosoMap.tsx`, `hooks.ts`, and
`ReportForm.tsx` are a complete worked example of a client built against that
interface: the map rendering and the React bindings are the parts that would
actually need rewriting for React Native, not the data layer underneath them.

A prior version of this repo did exactly that with Expo + `react-native-maps`,
including a discrete-freshness-state marker strategy (native `Marker` views
can't afford a continuously animated fade the way an SVG can) and a Metro
monorepo config. Neither survived into this version, but the pattern is real
and worth re-deriving rather than guessing at from scratch.

## Deploying to GitHub Pages

Soso can deploy as a static export to GitHub Pages, because every Supabase
call in the app happens in the browser (`src/web/supabase.ts`,
`demo-gateway.ts`) — there are no server components fetching data, no route
handlers, no server actions. `output: "export"` in `next.config.ts` turns
`next build` into a plain folder of HTML/JS/CSS (`apps/web/out`) with no Node
server required, which is exactly what a static file host like GitHub Pages
serves.

**One thing to decide first: user page or project page.**

- A repo literally named `<your-github-username>.github.io` deploys to your
  domain root (`https://<username>.github.io/`). No extra config.
- Any other repo name deploys under a subpath
  (`https://<username>.github.io/<repo-name>/`), and Next needs to know that
  subpath at build time via `basePath` — get this wrong and the page loads
  with every asset 404ing, because the HTML asks for `/​_next/...` when the
  files actually live at `/<repo-name>/_next/...`.

`next.config.ts` reads this from a `NEXT_BASE_PATH` env var, empty by
default, so local dev is unaffected either way.

**Setup, once:**

1. Repo → Settings → Pages → **Build and deployment → Source: GitHub
   Actions.**
2. Repo → Settings → Secrets and variables → Actions → **Variables** tab (not
   Secrets — see why below) → add `NEXT_PUBLIC_SUPABASE_URL` and
   `NEXT_PUBLIC_SUPABASE_ANON_KEY`. If this is a project page, also add
   `NEXT_BASE_PATH` set to `/<repo-name>`. Skip all three and the site will
   simply build in demo mode, same as running it locally with no `.env.local`.
3. Make sure your code is actually pushed to GitHub, including
   `package-lock.json` and the `.github/workflows/` folder — see [Build and
   run](#build-and-run) above if you started from a downloaded copy rather
   than an existing clone; that gap is the most common reason this doesn't
   run at all. Then push to `main`. `.github/workflows/deploy-pages.yml`
   installs, runs the
   `packages/core` test suite, builds the static export with those values
   baked in, and publishes it.

**Why repository *variables* and not *secrets*:** a Supabase anon key is
designed to be public — it's what's protecting the data that matters, Row
Level Security, not keeping the key hidden. `NEXT_PUBLIC_*` values get
compiled directly into the JavaScript bundle at build time (there's no server
left at request time to read `process.env` from), so it would end up visible
in the shipped files regardless of which GitHub Actions context supplied it.
Putting it in **Secrets** would suggest a confidentiality guarantee that
doesn't exist and isn't needed.

**The `.nojekyll` gotcha:** GitHub Pages runs the Jekyll static site generator
over your files by default, and Jekyll ignores any folder starting with an
underscore — which is exactly what Next names its asset folder,
`_next/`. Without a `.nojekyll` file, Pages silently drops every JS and CSS
file and you get a blank page with a wall of 404s in the console. This repo
already has an empty `apps/web/public/.nojekyll`, which `next build` copies
into `out/` automatically; you don't need to do anything about it unless
you've deleted it.

**Updating the Supabase URL or key later** means pushing again — these values
are baked into the build, not read at runtime, so editing the repo variable
alone doesn't change anything live until the next deploy.

**Both basePath configurations are verified against the actual build
output**, not just Next's documentation: the root-page (`NEXT_BASE_PATH`
unset) and project-page (`NEXT_BASE_PATH=/soso`) exports were built, and every
asset reference in the exported HTML carries the correct prefix in each case.

## Known gaps



- **The SQL has never run against a live Postgres instance.** Every migration
  and `seed.sql` is validated for syntax with a real Postgres parser as part
  of development, and that's all. `npm run db:reset` against a real project
  is the first real test.
- **Anonymous sign-in is a development shortcut, not a launch setting.** An
  anonymous Supabase account costs nothing to create, so the per-user rate
  limit and reputation floor in `create_post` currently defend against one
  account, not one person with a script. This needs phone verification before
  the Supabase-backed mode is used with strangers.
- **No early resolution.** A `seats` post lives for its full 20-minute TTL even
  if the tables fill up two minutes in. There's no `resolve_post` RPC. Given
  that `seats` is explicitly a launched feature now, this is the most
  material gap to close next.
- **No photo uploads**, despite `post_media` existing in the schema.
- **No push notifications**, despite `cell_subscriptions` existing as the
  intended hook — the Edge Function that would publish to FCM on insert isn't
  built.
- **Demo mode and `seed.sql` can silently drift.** There is nothing enforcing
  that a category change in the database gets mirrored into
  `demo-gateway.ts`'s hand-written config. If you change a category's
  behaviour, update both.
- **A live backend outage mid-session isn't detected** — see
  [Demo mode](#demo-mode) above.
- **No Japanese UI strings.** `label_ja` exists in the schema and is loaded
  into `CategoryConfig`, but the web app only ever renders `labelEn`.
  Bilingual support is a real requirement for this market and is currently
  unstarted.
- **GitHub Pages has no server at all**, so it inherits every limitation of
  the Supabase-anon-key-in-the-browser model rather than adding new ones:
  fine for this app today, but it means there's nowhere to eventually add a
  server-side moderation webhook, an image-resizing endpoint, or anything
  else that shouldn't run in the visitor's own browser — that would need a
  different host (Vercel, or a small Node server) when the time comes.
- **Pages' CDN caches aggressively.** A deploy can take a few minutes to
  actually replace what visitors see, which matters if you're debugging a
  just-pushed change and it looks like nothing happened yet.
