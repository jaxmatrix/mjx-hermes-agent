package io.crates.keyring

import android.content.Context

/**
 * Kotlin binding for android-native-keyring-store's ndk-context initializer.
 *
 * The package/class/method names are load-bearing: the native implementation is exported
 * from the app's main Rust `.so` as
 * `Java_io_crates_keyring_Keyring_00024Companion_initializeNdkContext`, so this must stay
 * `io.crates.keyring.Keyring.Companion.initializeNdkContext`. No `System.loadLibrary` is
 * needed — the symbol lives in the app library that the Tauri activity already loaded.
 */
class Keyring {
    companion object {
        external fun initializeNdkContext(context: Context)
    }
}
