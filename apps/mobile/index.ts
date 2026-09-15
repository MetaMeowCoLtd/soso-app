// Must load before anything that might call crypto.randomUUID() or `new URL()`
// — both packages/core (avatar.ts's randomAvatarToken, share.ts) and the
// ported demo-gateway below call these at module-load-adjacent times, so the
// polyfills have to be the first thing this entry point does, not something
// deferred into a component.
import 'react-native-get-random-values';
import 'react-native-url-polyfill/auto';

import { registerRootComponent } from 'expo';

import App from './App';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
