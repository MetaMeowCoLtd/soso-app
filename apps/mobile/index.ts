// Must load before anything that might call crypto.randomUUID() or `new URL()`
// — both packages/core (avatar.ts's randomAvatarToken, share.ts) and
// src/data/demo-gateway.ts call these at module-load-adjacent times, so the
// polyfills have to be the first thing this entry point does, not something
// deferred into a component.
//
// `react-native-get-random-values` only patches `crypto.getRandomValues` —
// it does NOT add `crypto.randomUUID`, a separate Web Crypto method. Every
// `crypto.randomUUID()` call site (getMe(), seedIfEmpty(), createPost(), ...
// in demo-gateway.ts) was calling `undefined()` until this was added: the
// failure was silent until something that hadn't run yet in the current
// session — `getMe()`, specifically, the first time any screen needed a
// "who am I" id — hit it first. Confirmed by which screens broke and which
// didn't: `listFeedPosts`/`userProfile`/`listUserPosts` all call `getMe()`;
// `feedDelta`/`cellCounts`/`loadCategories` (the Map tab's calls) don't.
import 'react-native-get-random-values';
import 'react-native-url-polyfill/auto';
import { randomUUID } from 'expo-crypto';

if (typeof crypto.randomUUID !== 'function') {
  // @ts-expect-error — `crypto` here is react-native-get-random-values'
  // polyfilled object, whose type declarations don't (and shouldn't) claim
  // `randomUUID` support ahead of this assigning it.
  crypto.randomUUID = randomUUID;
}

import { registerRootComponent } from 'expo';

import App from './App';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
