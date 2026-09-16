const { withEntitlementsPlist } = require("@expo/config-plugins");

/**
 * expo-notifications autolinks its own config plugin during `expo prebuild`
 * regardless of whether it's listed in app.json's `plugins` array, adding
 * `aps-environment` to the entitlements unconditionally. A free ("personal
 * team") Apple Developer account cannot provision the Push Notifications
 * capability at all, so any build with this entitlement fails codesigning.
 * This plugin runs last and strips it back out.
 */
module.exports = function withoutPushEntitlement(config) {
  return withEntitlementsPlist(config, (config) => {
    delete config.modResults["aps-environment"];
    return config;
  });
};
