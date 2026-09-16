const fs = require("fs");
const path = require("path");
const { withAppDelegate, withInfoPlist, withXcodeProject, IOSConfig } = require("@expo/config-plugins");

/**
 * iOS 27 turns "app never adopted UIScene lifecycle" from a console warning
 * into a fatal EXC_BREAKPOINT at launch (crash frame:
 * UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption). Expo's
 * generated AppDelegate.swift creates its UIWindow directly in
 * didFinishLaunchingWithOptions and never declares UIApplicationSceneManifest,
 * which is exactly the pattern iOS 27 now rejects. This plugin adds a real
 * SceneDelegate and moves window creation there, since `expo prebuild`
 * regenerates ios/ from scratch and a one-off hand edit wouldn't survive it.
 */
const SCENE_DELEGATE_FILENAME = "SceneDelegate.swift";

const SCENE_DELEGATE_SOURCE = `import React
import UIKit

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
    guard let windowScene = scene as? UIWindowScene,
      let appDelegate = UIApplication.shared.delegate as? AppDelegate,
      let factory = appDelegate.reactNativeFactory
    else {
      return
    }

    let window = UIWindow(windowScene: windowScene)
    self.window = window
    appDelegate.window = window
    factory.startReactNative(withModuleName: "main", in: window, launchOptions: nil)
  }

  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    guard let url = URLContexts.first?.url else { return }
    RCTLinkingManager.application(UIApplication.shared, open: url, options: [:])
  }

  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    RCTLinkingManager.application(UIApplication.shared, continue: userActivity, restorationHandler: { _ in })
  }
}
`;

const APP_DELEGATE_OLD_BLOCK = `#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif
`;

function withSceneManifest(config) {
  return withInfoPlist(config, (config) => {
    config.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: "Default Configuration",
            UISceneDelegateClassName: "$(PRODUCT_MODULE_NAME).SceneDelegate",
          },
        ],
      },
    };
    return config;
  });
}

function withSceneDelegateFile(config) {
  return withXcodeProject(config, (config) => {
    const projectRoot = config.modRequest.platformProjectRoot;
    const appName = config.modRequest.projectName;
    const filePath = path.join(projectRoot, appName, SCENE_DELEGATE_FILENAME);
    fs.writeFileSync(filePath, SCENE_DELEGATE_SOURCE);

    const project = config.modResults;
    const alreadyLinked = Object.values(project.hash.project.objects["PBXFileReference"] ?? {}).some(
      (entry) => entry && typeof entry === "object" && entry.path === `"${SCENE_DELEGATE_FILENAME}"`
    );
    if (!alreadyLinked) {
      IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
        filepath: filePath,
        groupName: appName,
        project,
      });
    }

    config.modResults = project;
    return config;
  });
}

function withAppDelegateSceneChanges(config) {
  return withAppDelegate(config, (config) => {
    const contents = config.modResults.contents;
    if (!contents.includes(APP_DELEGATE_OLD_BLOCK)) {
      if (contents.includes("UIWindow(windowScene:")) {
        // Already patched by a previous prebuild pass.
        return config;
      }
      throw new Error(
        "withSceneLifecycle: expected window-creation block not found in AppDelegate.swift — " +
          "the Expo/React Native template changed; update withSceneLifecycle.js to match."
      );
    }
    config.modResults.contents = contents.replace(APP_DELEGATE_OLD_BLOCK, "");
    return config;
  });
}

module.exports = function withSceneLifecycle(config) {
  config = withSceneManifest(config);
  config = withSceneDelegateFile(config);
  config = withAppDelegateSceneChanges(config);
  return config;
};
