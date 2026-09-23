import { invoke } from '@tauri-apps/api/core'

import { IS_MOBILE } from '@/lib/platform'

type PermissionState = 'granted' | 'denied' | 'prompt' | 'prompt-with-rationale'

interface MicPermissionStatus {
  microphone: PermissionState
}

/**
 * Ensures the native OS microphone permission before the webview opens the mic.
 *
 * Desktop / plain-browser / vitest: no native gate — the webview (WebKitGTK /
 * WKWebView / WebView2) requests the OS permission itself on `getUserMedia`, so we
 * short-circuit to `true` and let that flow (and its NotAllowedError handling) run.
 *
 * Mobile (Android/iOS): pre-flight via `tauri-plugin-mic` — check first, and only
 * show the system dialog (`request_permission`) when the state is still promptable.
 * Any IPC error fails open (returns `true`) so the plugin stays a pure enhancement:
 * the subsequent `getUserMedia` still surfaces a real denial as `NotAllowedError`.
 */
export async function ensureMicPermission(): Promise<boolean> {
  if (!IS_MOBILE) {
    return true
  }

  try {
    let status = await invoke<MicPermissionStatus>('plugin:mic|check_permission')

    if (status.microphone === 'prompt' || status.microphone === 'prompt-with-rationale') {
      status = await invoke<MicPermissionStatus>('plugin:mic|request_permission')
    }

    return status.microphone === 'granted'
  } catch {
    return true
  }
}
