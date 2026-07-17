// STUB — universal is single-window (Tauri webview / mobile), unlike desktop's
// Electron multi-window shell. The ported composer's pop-out + metrics hooks
// gate on isSecondaryWindow(); here it's always the primary window.

export function isSecondaryWindow(): boolean {
  return false
}

// No secondary windows to open into — kept for import-site parity with desktop.
export async function openSessionInNewWindow(_sessionId: string, _opts?: { watch?: boolean }): Promise<void> {
  /* no-op: single-window */
}
