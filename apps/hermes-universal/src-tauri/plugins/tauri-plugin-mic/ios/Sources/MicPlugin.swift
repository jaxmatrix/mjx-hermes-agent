import AVFoundation
import SwiftRs
import Tauri
import UIKit
import WebKit

/**
 * iOS side of tauri-plugin-mic.
 *
 * Unlike Android, Tauri's base `Plugin` has no AVAudioSession-aware permission
 * implementation, so we override `checkPermissions` / `requestPermissions` and map
 * `AVAudioSession`'s three-state record permission onto the same
 * `{ "microphone": <state> }` shape the Rust `PermissionStatus` expects.
 *
 * Requires `NSMicrophoneUsageDescription` in the app Info.plist (provided durably
 * by src-tauri/Info.ios.plist) — accessing the mic without it crashes the app.
 */
class MicPlugin: Plugin {
  private func stateString(_ permission: AVAudioSession.RecordPermission) -> String {
    switch permission {
    case .granted:
      return "granted"
    case .denied:
      return "denied"
    case .undetermined:
      return "prompt"
    @unknown default:
      return "prompt"
    }
  }

  @objc public override func checkPermissions(_ invoke: Invoke) {
    let state = stateString(AVAudioSession.sharedInstance().recordPermission)
    invoke.resolve(["microphone": state])
  }

  @objc public override func requestPermissions(_ invoke: Invoke) {
    AVAudioSession.sharedInstance().requestRecordPermission { granted in
      invoke.resolve(["microphone": granted ? "granted" : "denied"])
    }
  }
}

@_cdecl("init_plugin_mic")
func initPlugin() -> Plugin {
  return MicPlugin()
}
