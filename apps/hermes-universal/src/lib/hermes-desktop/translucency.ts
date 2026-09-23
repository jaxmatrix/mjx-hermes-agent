/**
 * `glassSupported`, `translucencySupported` and `setTranslucency`, over Rust's
 * window appearance (`src-tauri/src/appearance/`).
 *
 * The two facts are read at MODULE SCOPE by `store/translucency.ts`, before the
 * first paint, so they have to be answerable without an `await`. They are:
 * `appearance_capabilities` decides both from the OS — and, on Windows, the
 * build number — and `tauri-plugin-os` injects exactly those into the page
 * before any script runs (`platform()`, `version()`; Rust's `os_build()` reads
 * the same `tauri_plugin_os::version()`). The table below is
 * `appearance/{linux,mac,win,none}.rs::probe`, not a guess at it:
 *
 *   linux    Clear yes (GTK opacity)   Glass no  (no compositor material)
 *   macos    Clear yes                 Glass yes
 *   windows  Clear yes                 Glass from build 22621 (Windows 11 22H2)
 *   other    neither — a phone has no window manager to show through
 *
 * That INVERTS Electron's Linux answer on purpose (`setOpacity` is a no-op
 * there; GTK's is not). Without these members desktop falls back to a
 * Mac-or-Windows sniff and hides the row on the one OS where it always worked.
 *
 * With no runtime to ask (plain-browser dev, vitest) both stay ABSENT and
 * desktop's own fallback applies.
 */

import { version } from '@tauri-apps/plugin-os'

import { IS_DESKTOP, PLATFORM } from '@/lib/platform'
import { WINDOWS_GLASS_MIN_BUILD } from '@/lib/translucency-model'

type Bridge = NonNullable<typeof window.hermesDesktop>

/** `10.0.22631` → 22631, as `win.rs::os_build` reads `Version::Semantic`. */
function windowsBuild(): null | number {
  try {
    const build = Number(version().split('.')[2])

    return Number.isInteger(build) ? build : null
  } catch {
    return null
  }
}

function support(): null | { glass: boolean; translucency: boolean } {
  switch (IS_DESKTOP ? PLATFORM : '') {
    case 'linux':
      return { glass: false, translucency: true }

    case 'macos':
      return { glass: true, translucency: true }

    case 'windows':
      return { glass: (windowsBuild() ?? 0) >= WINDOWS_GLASS_MIN_BUILD, translucency: true }

    default:
      return null
  }
}

/** Imported once: a Clear-mode drag pushes per tick. Dynamic because the window
 *  store is outside the install graph. */
let native: null | Promise<{ apply: (state: unknown) => Promise<unknown>; glassBacked: boolean }> = null

function nativeLever() {
  native ??= Promise.all([import('@tauri-apps/api/core'), import('@/store/windows')]).then(
    ([{ invoke }, { isGlassBackedWindow }]) => ({
      apply: (state: unknown) => invoke('appearance_set_glass', { state }),
      glassBacked: isGlassBackedWindow()
    })
  )

  return native
}

/**
 * The NATIVE half of the resolved state, onto the calling window. `scope` stays
 * behind: it decides which page surfaces thin and moves no native property
 * (`appearance/model.rs`, `GlassRequest`, whose two levers are `u8`).
 *
 * Only a window that hosts the app's field takes the lever — never the HUD or
 * the wake light (`isGlassBackedWindow`). Fire-and-forget, as Electron's `send`
 * is: Rust diffs per window label, so a slider drag under glass costs nothing
 * native, and a refusal is cosmetic — the window stays opaque (recipe 6.2).
 */
const setTranslucency: NonNullable<Bridge['setTranslucency']> = state => {
  const half = {
    fade: Math.round(state.fade),
    intensity: Math.round(state.intensity),
    material: state.material,
    mode: state.mode
  }

  void nativeLever()
    .then(lever => (lever.glassBacked ? lever.apply(half) : undefined))
    .catch(() => undefined)
}

export function translucencyBridge(): Partial<
  Pick<Bridge, 'glassSupported' | 'setTranslucency' | 'translucencySupported'>
> {
  const supported = support()

  return supported
    ? { glassSupported: supported.glass, setTranslucency, translucencySupported: supported.translucency }
    : {}
}
