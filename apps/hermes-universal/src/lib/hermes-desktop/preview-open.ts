/**
 * Preview pane helpers: open in the OS browser + the Electron shortcut gate.
 *
 * `openPreviewInBrowser` reuses `openExternal` (http(s)/mailto/local file).
 * `setPreviewShortcutActive` is a no-op: Universal's keybinds are not gated by
 * an Electron main-process menu flag.
 */

import { externalBridge } from './external'

type Bridge = NonNullable<typeof window.hermesDesktop>

const openPreviewInBrowser: NonNullable<Bridge['openPreviewInBrowser']> = async url => {
  await externalBridge.openExternal(String(url ?? '').trim())
}

const setPreviewShortcutActive: NonNullable<Bridge['setPreviewShortcutActive']> = _active => {
  // Electron toggled menu accelerators for the preview pane. Universal registers
  // chords in Rust (`shortcuts.rs`) from the binding store — no main-side gate.
}

export const previewOpenBridge: Pick<Bridge, 'openPreviewInBrowser' | 'setPreviewShortcutActive'> = {
  openPreviewInBrowser,
  setPreviewShortcutActive
}
