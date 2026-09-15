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
// Metro walks up from the importing file. If a real hoisting collision with
// packages/core's own deps shows up once C2 adds the relative import, the
// fix is `resolver.extraNodeModules` as a scoped fallback, not disabling
// hierarchical lookup outright.
const projectRoot = __dirname;
const coreRoot = path.resolve(projectRoot, "../../packages/core");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [coreRoot];

module.exports = config;
