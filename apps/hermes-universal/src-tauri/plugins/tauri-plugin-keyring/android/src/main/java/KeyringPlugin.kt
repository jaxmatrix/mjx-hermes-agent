package com.charlesportwoodii.tauri.plugin.keyring

import android.app.Activity
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Plugin

/**
 * Android plugin for Tauri Keyring Plugin.
 * 
 * This plugin provides the Android interface for Tauri's plugin system.
 * All keyring operations are handled by Tauri commands which delegate
 * to the Rust implementation using android-native-keyring-store for
 * direct Android Keystore access.
 */
@TauriPlugin
class KeyringPlugin(private val activity: Activity): Plugin(activity) {
    // Empty implementation - all functionality is handled by Tauri commands
    // defined in the Rust layer (commands.rs) which use the shared
    // KeyringImplementation with Android-specific native store
}
