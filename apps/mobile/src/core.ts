// apps/mobile is deliberately NOT an npm workspace member (see the repo
// README's "Monorepo structure"), so packages/core is consumed via a plain
// relative filesystem import — never the `soso-core` package name, never a
// tsconfig path alias. Every other file in this app should import from
// "./core" (or the appropriate relative path to this file), not repeat the
// four-levels-up path to packages/core/src/index directly — one place to
// fix if this app ever moves, or if packages/core grows a build step.
export * from "../../../packages/core/src/index";
