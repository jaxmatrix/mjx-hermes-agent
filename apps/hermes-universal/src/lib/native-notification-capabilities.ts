import { IS_NATIVE_MOBILE } from './platform'

export interface NativeNotificationCapabilities {
  /** Action BUTTONS on the notification. */
  actions: boolean
  /** A tap on the notification (or one of its buttons) reaching this app. */
  activation: boolean
}

/**
 * What OS notifications can actually do here — asked, never inferred (rule 10).
 *
 * THE INVERSION worth stating, because it is the opposite of the usual matrix:
 * action buttons and click activation are MOBILE-ONLY.
 * `tauri-plugin-notification` registers exactly three commands on desktop
 * (`notify`, `request_permission`, `is_permission_granted`); `register_action_types`
 * exists only in its `src/mobile.rs`, and its desktop half has no click hook at
 * all. So on Windows, Linux and macOS a notification is fire-and-forget: no
 * buttons, and no body-tap either.
 *
 * A FUNCTION rather than a const, for two reasons. `lib/platform`'s detection can
 * resolve late on iOS (the webview boot race, MJX-203), and freezing an answer at
 * THIS module's init would bake in whatever was known then. And when a Rust
 * notification backend eventually gives desktop real actions, every caller
 * already asks instead of assuming — which is the point of putting the
 * capability behind a call rather than behind a platform check at each site.
 */
export function nativeNotificationCapabilities(): NativeNotificationCapabilities {
  return { actions: IS_NATIVE_MOBILE, activation: IS_NATIVE_MOBILE }
}
