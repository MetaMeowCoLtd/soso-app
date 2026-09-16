const { withXcodeProject } = require("@expo/config-plugins");

/**
 * Xcode 15+ defaults new projects to `ENABLE_USER_SCRIPT_SANDBOXING = YES`,
 * which blocks Run Script build phases from writing into the app bundle —
 * including React Native's own `react-native-xcode.sh`, whose device-build
 * branch writes the Mac's LAN IP to `ip.txt` inside the .app bundle so a
 * physical-device debug build knows where to reach Metro. With sandboxing
 * on, that write fails with "Operation not permitted" and the whole build
 * aborts at the "Bundle React Native code and images" phase — the exact
 * failure hit when getting this app running on a real device for the
 * first time.
 *
 * `expo prebuild` regenerates `ios/` from scratch, so a one-off edit to
 * `project.pbxproj` doesn't survive it — this plugin re-applies the fix on
 * every prebuild instead.
 */
module.exports = function withDisableScriptSandboxing(config) {
  return withXcodeProject(config, (config) => {
    const project = config.modResults;
    const configurations = project.pbxXCBuildConfigurationSection();
    for (const key in configurations) {
      const entry = configurations[key];
      if (entry && typeof entry === "object" && entry.buildSettings) {
        entry.buildSettings.ENABLE_USER_SCRIPT_SANDBOXING = "NO";
      }
    }
    return config;
  });
};
