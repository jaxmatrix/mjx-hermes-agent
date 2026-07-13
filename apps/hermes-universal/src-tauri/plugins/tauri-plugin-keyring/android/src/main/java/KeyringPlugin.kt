package com.charlesportwoodii.tauri.plugin.keyring

import android.app.Activity
import android.webkit.WebView
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Plugin
import io.crates.keyring.Keyring

/**
 * Android plugin for Tauri Keyring Plugin.
 *
 * All keyring operations are handled by Tauri commands which delegate to the Rust
 * implementation using android-native-keyring-store for direct Android Keystore access.
 *
 * The one thing that must happen on the Android side is initializing the global
 * `ndk_context` that android-native-keyring-store reads its Context/JavaVM from.
 * Tauri/wry does not do this for us, so we call the store crate's JNI initializer
 * from `load()` (which runs once the WebView exists, before any keyring command).
 */
@TauriPlugin
class KeyringPlugin(private val activity: Activity): Plugin(activity) {
    override fun load(webView: WebView) {
        super.load(webView)
        // Populate ndk_context with the application context via the store crate's
        // JNI entry point. Idempotent (guarded by a OnceLock inside the crate).
        Keyring.initializeNdkContext(activity.applicationContext)
    }
}
