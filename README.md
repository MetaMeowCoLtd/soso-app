# Soso

Soso is a location-based reporting platform. Reports are location- and
time-bound: an accident, a lane closure, a lost item, or a table opening up
at a cafe. Every report follows the same model: a claim, tied to a location,
valid until a defined expiry. This model is what allows expiry, per-category
lifetimes, and a bounded working data set to be schema properties rather than
application-level logic.

This repository contains the web client: a Next.js and Leaflet map backed by
Supabase.

> This is a development-stage application, not an emergency service. For
> immediate danger, contact local emergency services.

## Overview

- A full-screen map. Clicking anywhere opens the report composer. Clicking an
  existing pin, or a row in the local updates panel, opens its detail view
  with corroboration and reporting controls.
- Reports have a server-assigned lifetime and expire automatically. There is
  no manual "resolved" state.
- Category behavior (lifetime, whether a description is required, whether the
  reporter must be physically present) is defined in database configuration,
  not application code. Enabling or disabling a category is a data change,
  not a deployment.
- The application runs without a Supabase project. If the backend is
  unreachable or unconfigured, the client falls back to a local demo mode
  automatically. See [Demo mode](#demo-mode).

## Features and status

| Feature | Status |
| --- | --- |
| Map with click-to-report | Implemented |
| Incident reporting (accident, hazard, crowding, outage) | Implemented |
| Construction and closures | Implemented |
| Lost and found | Implemented |
| Seat availability (restaurant, cafe) | Implemented |
| Per-category expiry (TTL) | Implemented. Server-assigned; the client cannot extend it. |
| Server-side validation (proximity, rate limits, body length, subtype) | Implemented. Enforced in Postgres, not in the client. |
| Corroboration ("still here" / "not true") with auto-hide on disputes | Implemented |
| Post reporting (flagging for review) | Implemented. Reports are recorded; no moderator workflow exists yet. |
| Local demo mode (no backend required) | Implemented |
| Polls | Modeled, disabled. Requires separate options/votes tables. |
| Local news and official notices | Modeled, disabled |
| Topic groups | Not implemented |
| Harassment reporting | Modeled, shipped disabled. Requires legal review before enabling; see the comment in `supabase/seed.sql`. |
| Photo uploads | Not implemented. The `post_media` table exists; nothing writes to it. |
| Push notifications | Implemented, not verified end-to-end. See [Push notifications](#push-notifications). |
| Early resolution (for example, marking seats full before TTL expiry) | Not implemented. All reports currently expire only via TTL. |
| Native iOS/Android application | Not present in this repository. See [Platforms](#platforms). |

## Platforms

**Web (this repository).** Next.js 15, React 19, and Leaflet, in `apps/web`.
Runs in any modern desktop or mobile browser. This is the primary
development target: no build queue, no store review process, no native
toolchain.

**iOS and Android.** Not present in this repository. An earlier
implementation used Expo and `react-native-maps` against the same backend. It
passed type checking, its test suite, and a production build. It was removed
to avoid maintaining two active clients while the web client's UI was still
changing frequently. The architecture that supported it is unchanged:

- `packages/core` (domain logic, the `SosoGateway` interface, the Supabase
  adapter, the incremental feed controller) contains no React, DOM, or React
  Native dependencies. It is platform-independent TypeScript.
- Platform-specific code (map rendering, framework bindings, fallback
  behavior) lives under each platform's own `apps/*` directory and depends on
  `packages/core` as its only shared dependency.

Reintroducing a mobile client means creating `apps/mobile` and implementing a
map, composer, and detail view against the existing `SosoGateway` interface,
the same interface `apps/web` uses. The schema, validation rules, and polling
strategy do not need to be re-derived. See [Native application
support](#native-application-support).

## Prerequisites

- Node.js 20 or later. Verify with `node --version`.
- A Supabase account (the free tier is sufficient). Optional: without one,
  the application runs in local demo mode.
- The Supabase CLI, required only to run the backend locally instead of
  against a hosted project: <https://supabase.com/docs/guides/cli>.

## Installation

If this project was obtained as a downloaded archive rather than cloned from
an existing Git repository, initialize one first. Skipping this step is the
most common cause of a repository missing its `.github` directory, or a CI
run failing because `package-lock.json` was never committed:

```bash
cd soso                 # the directory containing this README
git init
git branch -M main
npm install              # generates package-lock.json, required for CI
git add -A                # -A, not a file picker: dotfolders such as .github/
                           # are commonly excluded by GUI drag-and-drop
git commit -m "Initial commit"
git remote add origin https://github.com/<you>/<your-repo>.git
git push -u origin main
```

The GitHub Actions workflow runs `npm ci`, which requires
`package-lock.json` to be committed. Without it, CI fails immediately with a
"Dependencies lock file is not found" error. The lockfile only needs
regenerating (`npm install`, then commit) when a dependency changes;
ordinary code edits do not affect it.

If the repository is already set up, install dependencies directly:

```bash
npm install
```

This single command installs dependencies for both `packages/core` and
`apps/web`, which share one npm workspace. See [Monorepo
structure](#monorepo-structure) for why `apps/mobile` is not part of the same
workspace.

### Running without a backend

```bash
npm run dev
```

Open `http://localhost:3000`. With no `.env.local` present, the application
starts in demo mode: seeded reports near Tokyo Station, fully interactive,
persisted to the browser's `localStorage`.

### Running against a Supabase backend

There are two configurations, using different commands. `supabase db reset`
only affects a local Docker-based stack and cannot reach a hosted project.

**Local, using `supabase start`:**

1. Run `supabase start` (requires Docker).
2. Run `npm run db:reset`. This applies every file in `supabase/migrations/`
   in order, then `supabase/seed.sql`, against the local instance.
3. Set `apps/web/.env.local` to the local URL and anon key printed by
   `supabase start`.

**Hosted (required for GitHub Pages deployment):**

1. Create a project at supabase.com if one does not already exist. Note its
   project reference (the subdomain in its URL, for example `abcdefgh` in
   `https://abcdefgh.supabase.co`) and its database password (set at
   creation; resettable under Settings > Database).
2. Install the Supabase CLI if not already installed (`brew install
   supabase/tap/supabase` on macOS), then run:

   ```bash
   supabase login
   supabase link --project-ref <your-project-ref>
   supabase db push --include-seed
   ```

   `link` connects the local checkout to the hosted project. `db push
   --include-seed` applies every file in `supabase/migrations/` in order,
   including the RLS policies (see [Architecture](#architecture) for why
   these are not a separate deployment step), then `supabase/seed.sql`,
   which defines the product configuration: each category's TTL, proximity
   requirement, and body length limit as data, not code.

   Note on `--include-seed`: it runs the seed file only alongside a
   migration it is actively applying. Editing `seed.sql` without an
   accompanying new migration causes `db push --include-seed` to report "up
   to date" and skip seeding. In that case, apply the seed SQL directly in
   the Supabase dashboard's SQL Editor, or add a trivial new migration to
   give `push` something to apply.

3. If the `postgis` extension fails to enable during the push, enable it
   manually under Database > Extensions in the dashboard first, then retry.
4. Copy `apps/web/.env.local.example` to `apps/web/.env.local` and set the
   project's URL and anon key (Supabase dashboard > Settings > API).
5. In the Supabase dashboard, enable Authentication > Providers > Anonymous.
   The application signs users in anonymously to allow posting without a
   signup flow. See [Known limitations](#known-limitations) regarding this
   approach.
6. Run `npm run dev`, or push to trigger the GitHub Pages workflow if
   deploying rather than running locally.

If the backend is misconfigured or unreachable, the application falls back
to demo mode rather than failing. See [Demo mode](#demo-mode).

### Tests and type checking

```bash
npm test          # packages/core: 46 tests, pure logic, no database required
npm run typecheck  # packages/core and apps/web
npm run build      # production build of apps/web
```

The `packages/core` test suite does not touch a network or a database. SQL
migrations are validated for syntax using a Postgres parser during
development but have not been executed against a live instance. Running
`npm run db:reset` against a real project is the first execution of this
schema; treat it as a validation step, not a formality.

## Demo mode

`apps/web/src/web/bootstrap.ts` determines, once at startup, which backend
implementation to use. If `NEXT_PUBLIC_SUPABASE_URL` or
`NEXT_PUBLIC_SUPABASE_ANON_KEY` are missing, or a connection attempt times
out after six seconds, the application falls back to
`apps/web/src/web/demo-gateway.ts`, a complete second implementation of the
`SosoGateway` interface backed by `localStorage` instead of Postgres.

Every screen in the application depends on the `SosoGateway` interface and
has no knowledge of which implementation is active. This is a direct
consequence of the port/adapter separation used throughout the codebase, not
a feature designed specifically for demo mode.

Behavior matched to the real backend:

- The same five enabled categories, with identical TTLs, proximity radii,
  body limits, and subtypes, mirrored by hand from `supabase/seed.sql`. See
  the comment at the top of `demo-gateway.ts`: there is no automated
  mechanism keeping these two definitions synchronized.
- The same corroboration and auto-hide rule (three or more disputes,
  outnumbering confirmations more than 2:1, hides a post).
- The same validation error codes, so UI error messages are identical
  between modes.

Behavior that differs by design:

- **Not a security boundary.** The real backend enforces its rules in
  Postgres, outside client control. Demo mode's rules run in the browser and
  can be bypassed using developer tools. This is acceptable because demo
  mode only affects that browser's own local storage; there is no shared
  data to protect.
- **Location fuzzing does not run in practice.** All five enabled categories
  have `locationPrecisionM = 0`, so this code path exists for parity with
  `create_post` but is not currently exercised.
- **A backend outage mid-session is not detected.** The gateway is resolved
  once at startup and held for the life of the tab. If Supabase becomes
  unreachable after the page has loaded, the application does not detect
  this or fall back. Implementing that would require a circuit breaker that
  re-tests connectivity and swaps the active gateway under a live feed
  controller, which is a distinct feature from the startup fallback
  described here.

## Architecture

```
packages/core/     Domain logic, the SosoGateway interface, the Supabase
                    adapter, and the incremental feed controller. Pure
                    TypeScript with no React, DOM, or platform dependencies.
                    Covered by an isolated test suite.
apps/web/           Next.js and Leaflet. Contains all platform-specific
                    code: the map component, React hooks, and the demo-mode
                    fallback.
supabase/           The schema. migrations/ defines structure; seed.sql
                    defines product behavior and should be read as the
                    specification for what each category does.
```

**A single `posts` table, with configuration as data rather than code
branches.** An incident report, a lost item, and a seat-availability note are
the same underlying object, differing only by their row in
`post_categories`. Adding a category is an `INSERT`. Disabling one during a
legal review is an `UPDATE`. See the comments in
`supabase/migrations/20260828000003_core.sql` and `seed.sql`.

**Writes are performed through `SECURITY DEFINER` functions, not RLS insert
policies.** `create_post` centralizes TTL clamping, proximity checks, rate
limiting, and body length validation, returning error codes the client can
branch on. Clients cannot write a post directly. This is the mechanism
behind "server-side validation" in this project: the web form does not
duplicate these rules; it submits and displays whatever the server decides.
See `supabase/migrations/20260828000005_api.sql`.

**RLS policies are ordinary migration SQL, not a separate deployment
artifact.** They are defined in
`supabase/migrations/20260828000004_rls.sql`, alongside the tables and
functions in the other migration files, and `supabase db push` applies all
of them in one sequence. There is no separate command or dashboard action to
"push policies." The dashboard's Authentication > Policies tab is a view
onto what already exists in Postgres, not an alternate management path.
Changing a policy requires a new migration (`drop policy ...; create policy
...`, since Postgres has no `create policy if not exists`) followed by
another push. Editing a policy directly in the dashboard changes the live
database without updating the corresponding migration file, causing the
repository and the hosted project to diverge.

**The feed is polled incrementally, not refetched in full.** `feed_delta`
accepts a cursor and returns only what changed since that cursor, along with
a tombstone list for anything that stopped being live. A quiet viewport
costs approximately 150 bytes per poll rather than tens of kilobytes. This
mechanism is also why pins expire in the UI without an additional request:
every pin carries its own `expiresAt`, and the client stops rendering it
once that time passes.

## Monorepo structure

`packages/core` and `apps/web` share a single npm workspace and
`node_modules` tree. A React Native application does not belong in the same
workspace: React Native and Next.js require incompatible major versions of
`react` and `react-dom`, and npm's dependency hoisting produces a broken
tree when required to satisfy both simultaneously. This is a structural
incompatibility between the two toolchains, not something a version pin
resolves. If `apps/mobile` is reintroduced, it should use its own `npm
install`, consuming `packages/core` the same way the previous
implementation did: through plain relative filesystem imports into
`packages/core/src`, which require no workspace symlink or module
resolution.

## Native application support

The interface to implement against is `SosoGateway`, defined in
`packages/core/src/data/gateway.ts`: five methods covering category
configuration, an incremental feed fetch, per-cell counts, post detail, and
the four write operations (create, vote, report, and push subscription
management). `apps/web`'s `SosoMap.tsx`, `hooks.ts`, and `ReportForm.tsx`
serve as a complete reference implementation against that interface. Map
rendering and framework bindings are the components that require
reimplementation for React Native; the data layer does not.

A previous implementation used Expo and `react-native-maps`, including a
discrete freshness-state marker strategy (native `Marker` views cannot
efficiently render a continuously animated fade, unlike an SVG-based
renderer) and a Metro monorepo configuration. Neither is present in the
current repository, but the pattern is documented here for reference rather
than requiring re-derivation from scratch.

## Deployment (GitHub Pages)

This application can be deployed as a static export to GitHub Pages because
every Supabase call originates in the browser (`src/web/supabase.ts`,
`demo-gateway.ts`). There are no server components performing data fetching,
no route handlers, and no server actions. Setting `output: "export"` in
`next.config.ts` causes `next build` to produce a static directory of HTML,
JavaScript, and CSS (`apps/web/out`) with no Node server dependency, which
is what a static host such as GitHub Pages requires.

### Repository type

- A repository named `<your-github-username>.github.io` deploys to the
  domain root (`https://<username>.github.io/`) with no additional
  configuration.
- Any other repository name deploys under a subpath
  (`https://<username>.github.io/<repo-name>/`), and Next requires that
  subpath at build time via `basePath`. An incorrect value causes every
  asset to 404, since the HTML references `/_next/...` while the files are
  served from `/<repo-name>/_next/...`.

`next.config.ts` reads this value from the `NEXT_BASE_PATH` environment
variable, which defaults to empty and does not affect local development.

### Setup

1. Repository Settings > Pages > Build and deployment > Source: GitHub
   Actions.
2. Repository Settings > Secrets and variables > Actions > Variables tab
   (not Secrets; see rationale below). Add `NEXT_PUBLIC_SUPABASE_URL` and
   `NEXT_PUBLIC_SUPABASE_ANON_KEY`. For a project-page deployment, also add
   `NEXT_BASE_PATH` set to `/<repo-name>`. Without these three variables,
   the site builds in demo mode, identical to local development without
   `.env.local`.
3. Confirm the repository includes `package-lock.json` and the
   `.github/workflows/` directory (see [Installation](#installation) if the
   project originated from a downloaded archive rather than a clone; a
   missing lockfile or workflow directory is the most common cause of a
   failed run). Push to `main`.
   `.github/workflows/deploy-pages.yml` installs dependencies, runs the
   `packages/core` test suite, builds the static export with the configured
   values, and publishes it.

**Repository variables, not secrets:** a Supabase anon key is designed to be
public. Row Level Security is the actual protection mechanism, not
concealment of the key. `NEXT_PUBLIC_*` values are compiled directly into
the JavaScript bundle at build time, since no server remains at request
time to read `process.env`, so the value is visible in the shipped files
regardless of which GitHub Actions context supplies it. Storing it under
Secrets would imply a confidentiality guarantee that does not apply and is
not required.

**The `.nojekyll` requirement:** GitHub Pages processes files through Jekyll
by default, and Jekyll excludes any directory beginning with an underscore,
which includes Next's asset directory, `_next/`. Without a `.nojekyll`
file, Pages silently omits all JavaScript and CSS, producing a blank page
with 404 errors in the console. This repository includes an empty
`apps/web/public/.nojekyll`, which `next build` copies into `out/`
automatically. No action is required unless this file has been removed.

**Updating the Supabase URL or key** requires a new deployment. These
values are compiled into the build rather than read at runtime, so editing
the repository variable alone has no effect until the next push.

Both the root-page (`NEXT_BASE_PATH` unset) and project-page
(`NEXT_BASE_PATH=/soso`) build configurations have been validated by
inspecting the exported HTML output directly, confirming that every asset
reference carries the correct prefix in each case.

## Push notifications

Subscribers receive a browser push notification when a report is posted in
an area they have enabled notifications for. The bell icon in the header
toggles this for approximately the 3 km block of cells surrounding the
map's current center.

**Status: implemented, not verified end-to-end.** Every other feature in
this project was confirmed by execution: test suites, a production build,
SQL syntax validation. This feature has not been executed in a deployed
environment; no Supabase Edge Function has been deployed and no push
notification has been received on a device during development. What has
been confirmed is internal consistency: the SQL parses correctly, the
TypeScript compiles, and the Web Push and VAPID APIs are called according
to their documented usage. The most likely point of failure on first
deployment is whether Deno's Node compatibility layer runs the
`npm:web-push` import without modification. If notifications do not arrive
after completing the setup steps below, investigate this first, using the
Dashboard: Edge Functions > notify-new-pin > Logs. The CLI's
`functions logs` subcommand does not exist in current versions and should
not be relied on; the Dashboard is the reliable path regardless of CLI
version.

### iOS requirement

Push notifications on iOS function only within a page added to the Home
Screen through Safari's Share > Add to Home Screen, opened subsequently
from that icon rather than from a browser tab. Chrome, Firefox, and every
other browser on iOS run on WebKit under an Apple platform requirement, and
none of them can create the standalone execution context push notifications
require on iOS. Adding the page to the Home Screen from Chrome does not
produce a context capable of receiving push notifications, regardless of
what UI Chrome presents for that action. The application detects this
condition (`getPushAvailability()` in `src/web/push.ts`) and displays
installation instructions instead of a non-functional control.

### Components

- `cell_subscriptions`: present in the schema since the initial migration
  and unused until this feature. Represents the areas a user has expressed
  interest in.
- `push_endpoints`: new in this feature. Represents which browsers can be
  reached, with one row per subscribed device. This is separate from
  `cell_subscriptions` so that a user opening the application on a second
  device does not need to redeclare which areas matter to them.
- A Supabase Dashboard Database Webhook calls an Edge Function for every new
  report. The function accepts the Dashboard's `INSERT` event format, selects
  only live reports, then looks up and notifies matching subscribers.
- `supabase/functions/notify-new-pin/` holds the VAPID private key as a
  server secret, since a private key cannot be present in a browser or in a
  version-controlled migration file. It queries matching subscribers, sends
  notifications via `web-push`, and removes any subscription a push service
  reports as permanently invalid (HTTP 404 or 410).

### Setup

None of the following occurs automatically from a `git push`.

1. **VAPID keys.** A working key pair was generated during development of
   this feature:

   ```
   Public:  BIlLJvv5uK5sWoYlSIcO7XGjfB1ZWc9sCykGBMNcpIhQNNJYnuic_XJbY-3oT6pyw8kqA6DtJsZaruBuHG3ax9o
   Private: v_0z1EDQWU-_lKuEJRYipPcgWK-luaslQ25m_5gmplY
   ```

   Treat the private key above as compromised, since it has been included
   in this document, and generate a new pair before using this feature in
   any non-development context:

   ```bash
   npx web-push generate-vapid-keys
   ```

2. **Configure the Edge Function's secrets:**

   ```bash
   supabase secrets set VAPID_PUBLIC_KEY=<public key>
   supabase secrets set VAPID_PRIVATE_KEY=<private key>
   supabase secrets set PUSH_TRIGGER_SECRET=<a long random value>
   ```

   Keep the random value private. It authenticates the Dashboard webhook to
   the function without putting a Supabase API key in a webhook header.

3. **Deploy the function without Supabase's JWT verification.** It is called
   by the Database Webhook, never by a browser. The function manually checks
   the private webhook header configured in the next step:

   ```bash
   supabase functions deploy notify-new-pin --no-verify-jwt
   ```

4. **Create the Database Webhook in the Supabase Dashboard.** Open
   **Database > Webhooks > Create a new webhook** and use:

   - Name: `notify-new-pin`
   - Table: `public.posts`
   - Events: **Insert** only
   - Type: **Supabase Edge Function**
   - Edge Function: `notify-new-pin`
   - HTTP header: `x-push-secret` with the exact random value used for
     `PUSH_TRIGGER_SECRET` in step 2

   Save it, then make one test post. Do not also use the old `pg_net` trigger:
   migration `20260830000008_dashboard_push_webhook.sql` removes it so a new
   report produces one notification, not two. For an existing hosted project,
   apply that migration with `supabase db push` before testing.

5. **Provide the client with the public key.** This value is safe to
   expose; that is the purpose of a VAPID public key. Add it to
   `apps/web/.env.local` for local development and as a repository variable
   for the GitHub Pages workflow, alongside the Supabase variables
   described above:

   ```
   NEXT_PUBLIC_VAPID_PUBLIC_KEY=<the same public key from step 1>
   ```

### Limitations

- **No area management interface.** Enabling notifications subscribes to a
  single approximately 3 km block around the map's current center at the
  time of subscription. There is no interface to view or manage multiple
  watched areas, or to subscribe to a second area from the same browser.
- **Disabling notifications does not remove the associated area.**
  Unsubscribing deletes the `push_endpoints` row but leaves the
  corresponding `cell_subscriptions` row in place. This has no functional
  effect, since a subscription with no endpoint delivers nothing, but the
  two operations are not symmetric.
- **The shared secret is a simplified authentication mechanism, not a
  robust access control model.** It is used only by legacy pg_net deployments.
  The recommended Database Webhook uses the project's service-key header;
  neither credential is exposed to the browser.

### Debugging a subscription or delivery

If tapping the bell reports `soso/unknown`, this version now exposes the
underlying database message in the in-app notice and logs the full error in
the browser console. The usual cause is that migration 0007 has not been
applied or PostgREST has not refreshed its schema cache. Run `supabase db
push`, then retry once after a minute.

After a successful subscription, the bell becomes yellow. It means both the
browser subscription and the `subscribe_to_push` database call succeeded.
Check the saved records in the SQL Editor (run as a project owner):

```sql
select user_id, endpoint, created_at from public.push_endpoints;
select user_id, cell_id, label from public.cell_subscriptions order by cell_id;
```

For a delivery test, use two different browsers or two anonymous accounts.
On the receiving device, first enable the bell. Post from the other account
within the same small map area; Soso watches a 3×3 cell block around the map
centre, so a report in a different neighbourhood will correctly match nobody.
Then open **Edge Functions > notify-new-pin > Logs**. A healthy invocation
contains `processing post` and `delivery complete` with a nonzero `sent`.
`no subscribers for cell` means the devices are not watching the same map
cell; `Unauthorized` means the webhook header is missing or does not match
`PUSH_TRIGGER_SECRET`; `unexpected webhook payload` means it is not
configured as an INSERT webhook on `public.posts`.

## Known limitations

- **The SQL schema has not been executed against a live Postgres
  instance.** Every migration and `seed.sql` is validated for syntax using
  a Postgres parser during development; this is the extent of pre-deployment
  verification. Running `npm run db:reset` against a real project is the
  first execution of this schema.
- **Anonymous sign-in is a development convenience, not a production
  authentication model.** Creating an anonymous Supabase account has no
  cost, so the per-user rate limit and reputation floor enforced by
  `create_post` currently constrain one account, not one person operating a
  script. Phone verification is required before using the Supabase-backed
  mode with untrusted users.
- **No early resolution mechanism exists.** A `seats` report remains live
  for its full 20-minute TTL even if the underlying condition changes
  within minutes. There is no `resolve_post` RPC. Since `seats` is an
  active feature, this is the most significant functional gap to address.
- **Photo uploads are not implemented**, despite the `post_media` table
  existing in the schema.
- **Push notifications are implemented but unverified end-to-end**, and
  have no area management interface beyond a single toggle. See [Push
  notifications](#push-notifications) for the complete list of limitations.
- **Demo mode and `seed.sql` can diverge without warning.** No mechanism
  enforces that a category change in the database is reflected in
  `demo-gateway.ts`'s manually maintained configuration. Both must be
  updated together when category behavior changes.
- **A backend outage occurring mid-session is not detected.** See [Demo
  mode](#demo-mode).
- **No Japanese-language UI strings are implemented.** `label_ja` exists in
  the schema and is loaded into `CategoryConfig`, but the web client renders
  only `labelEn`. Bilingual support is a substantive requirement for this
  market and has not been started.
- **GitHub Pages provides no server-side execution environment.** This
  means the application inherits the limitations of the anonymous-key-in-
  browser model without introducing new ones, which is acceptable for the
  application's current scope. It also means there is no location for a
  future server-side moderation webhook, image-resizing endpoint, or
  similar functionality that should not execute in the visitor's browser.
  Such functionality would require a different host, such as Vercel or a
  dedicated Node server.
- **GitHub Pages' CDN caches aggressively.** A deployment can take several
  minutes to become visible to end users, which is relevant when verifying
  a recently pushed change.
