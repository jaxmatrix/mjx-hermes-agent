/**
 * `setNativeTheme`: pin the NATIVE window's appearance to the app's light/dark
 * mode. Electron sets `nativeTheme.themeSource`; Tauri's is the window's theme,
 * which is what a glass window's material, the GTK variant and
 * `prefers-color-scheme` follow. `system` hands it back to the OS.
 *
 * Fire-and-forget, as Electron's `send` is: a refusal is cosmetic.
 */

type Bridge = NonNullable<typeof window.hermesDesktop>

export const nativeThemeBridge: Required<Pick<Bridge, 'setNativeTheme'>> = {
  setNativeTheme: mode => {
    const theme = mode === 'dark' || mode === 'light' ? mode : null

    void import('@tauri-apps/api/window')
      .then(({ getCurrentWindow }) => getCurrentWindow().setTheme(theme))
      .catch(() => undefined)
  }
}
