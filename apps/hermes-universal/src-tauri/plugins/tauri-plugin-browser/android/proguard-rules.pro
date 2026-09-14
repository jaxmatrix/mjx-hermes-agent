# The plugin class is reached by JNI from Rust (`register_android_plugin`), and
# its @Command methods are reached reflectively by Tauri's dispatcher. R8 has no
# way to see either, so without these keeps a RELEASE build compiles cleanly and
# the in-app browser simply never attaches — the same silent shape as the
# BiometricGate / RustWebView.getCookies traps this project has already been
# bitten by.
-keep class com.nousresearch.hermes.plugin.browser.** { *; }
-keepclassmembers class com.nousresearch.hermes.plugin.browser.** {
  @app.tauri.annotation.Command <methods>;
}

# The @InvokeArg argument classes are populated by reflection from JSON.
-keepclassmembers class com.nousresearch.hermes.plugin.browser.*Args {
  <fields>;
  <init>();
}
