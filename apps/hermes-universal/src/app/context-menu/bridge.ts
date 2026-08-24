import type { NativeContextFacts } from '@/app/context-menu/registry'
import { applyNativeFacts } from '@/app/context-menu/store'
import { IS_TAURI } from '@/lib/platform'

// The TS half of the platform bridge.
//
// Universal must `preventDefault()` every gesture it owns — WebKitGTK, WKWebView,
// WebView2 and the Android WebView all pop their OWN menu otherwise — and that
// is exactly the channel desktop's Electron build got its late facts from. So
// the facts come back from the EMBEDDER instead of from the page, over one
// window-scoped event.
//
// In v1 nothing emits it: `context_menu_install` returns an all-false
// `BridgeSupport` on every platform, which is a true answer rather than a stub
// that lies (rule 10). The listener and the applier exist anyway so a v2 engine
// adapter is additive — no new command, no new event, no JS edit.

export const CONTEXT_MENU_NATIVE_EVENT = 'hermes://context-menu'

/** What the native bridge can actually do here. All false until an adapter lands. */
export interface ContextMenuBridgeSupport {
  nativeSuppressed: boolean
  spelling: boolean
  imageBytes: boolean
}

const NO_SUPPORT: ContextMenuBridgeSupport = { imageBytes: false, nativeSuppressed: false, spelling: false }

let installed = false
let support = NO_SUPPORT

/** What the platform answered at boot — for the diagnostics row, never inferred. */
export function contextMenuBridgeSupport(): ContextMenuBridgeSupport {
  return support
}

/**
 * Arm the bridge for THIS webview. Idempotent; a no-op off Tauri.
 *
 * Called once from `main.tsx` rather than from the coordinator: the Rust side
 * keys its handlers by window label, and a component that mounts, unmounts and
 * remounts must not re-wire them.
 */
export function installContextMenuBridge(): void {
  if (installed || !IS_TAURI) {
    return
  }

  installed = true

  void (async () => {
    try {
      const [{ invoke }, { getCurrentWebviewWindow }] = await Promise.all([
        import('@tauri-apps/api/core'),
        import('@tauri-apps/api/webviewWindow')
      ])

      support = await invoke<ContextMenuBridgeSupport>('context_menu_install')

      // Window-scoped, not `listen()`: Rust emits with `emit_to(label, …)`, and
      // the default `{kind:'Any'}` listener matches nothing such an emit sends.
      await getCurrentWebviewWindow().listen<NativeContextFacts>(CONTEXT_MENU_NATIVE_EVENT, event =>
        applyNativeFacts(event.payload)
      )
    } catch {
      // No bridge on this target — the menu is JS-only, which is v1 everywhere.
    }
  })()
}

/** Test seam. */
export function __resetContextMenuBridge(): void {
  installed = false
  support = NO_SUPPORT
}
