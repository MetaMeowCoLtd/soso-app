const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

// apps/mobile is deliberately NOT an npm workspace member (see the repo
// README's "Monorepo structure" — React Native and Next.js need
// incompatible major react/react-dom versions, and npm hoisting can't
// satisfy both). packages/core is consumed via plain relative filesystem
// imports into packages/core/src, never the `soso-core` package name and
// never a tsconfig path alias.
//
// packages/core ships raw TypeScript (main/types both point at src/index.ts,
// no build step), so Metro needs to be told to watch that directory outside
// its own project root — otherwise a relative import into it wouldn't be
// visible to the bundler at all, let alone hot-reload on change.
//
// Deliberately NOT touched here: `resolver.nodeModulesPaths` /
// `disableHierarchicalLookup`. An earlier version of this file forced both,
// on the theory that anything packages/core imports (e.g.
// `@supabase/supabase-js`) should resolve against apps/mobile's own
// node_modules rather than the npm workspace's hoisted tree at the repo
// root. In practice `disableHierarchicalLookup: true` also disables Metro's
// normal upward search from *every* file, including Expo's own internals —
// `expo-asset` isn't flattened to the top level here, it sits nested at
// node_modules/expo/node_modules/expo-asset, and only resolves because
// Metro walks up from the importing file.
//
// The real collision landed differently than that comment predicted: C2
// initially installed `@supabase/supabase-js` directly into apps/mobile too,
// on the assumption it needed its own copy. That produced two physically
// distinct installs of the same package — one here, one hoisted to the repo
// root because packages/core/package.json declares it as a direct
// dependency — and `tsc` correctly treated their two `SupabaseClient`
// classes as different types (protected members make structural typing
// fail across separate installs). The fix was the opposite of adding
// resolver config: apps/mobile does NOT install `@supabase/supabase-js` at
// all, so both packages/core's import and apps/mobile/src/data/supabase.ts's
// own import resolve to the exact same physical copy at the repo root.
//
// That copy lives outside both `projectRoot` and `watchFolders`, which
// matters because Metro's file-serving layer (Haste) refuses to read
// anything outside those roots — a targeted `resolver.extraNodeModules`
// mapping for just `@supabase/supabase-js` got the specifier resolved, but
// Metro still refused to serve the file, and the same problem recurred one
// level deeper for supabase-js's own transitive deps (auth-js, then
// auth-js's own dependency on `tslib`, hoisted to the root node_modules by
// npm same as everything else). Chasing each transitive dependency into
// watchFolders individually doesn't scale, so the root `node_modules`
// directory itself is watched instead of any specific package inside it —
// covers this whole hoisted dependency tree in one entry, with no
// extraNodeModules override needed once Metro's default hierarchical
// lookup can actually reach it.
//
// Deliberately the repo's `node_modules`, not the repo root itself: the
// latter would also pull `apps/web` (its own node_modules, Next.js build
// output) into Metro's watch set for no benefit. Metro's nearest-wins
// resolution order means apps/mobile's own node_modules is still checked
// before this fallback for every bare specifier, so watching it does not
// risk apps/mobile picking up a different react/react-native than the one
// it has installed locally.
const projectRoot = __dirname;
const repoRoot = path.resolve(projectRoot, "../..");
const coreRoot = path.resolve(repoRoot, "packages/core");
const repoNodeModules = path.resolve(repoRoot, "node_modules");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [coreRoot, repoNodeModules];

module.exports = config;
