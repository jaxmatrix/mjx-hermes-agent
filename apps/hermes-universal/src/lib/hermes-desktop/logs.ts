/**
 * Desktop / app logs over Rust `app_log.rs` — Electron `hermes:logs:*` +
 * `hermes:fs:logsRoot`. File: `<HERMES_HOME>/logs/desktop.log`.
 */

type Bridge = NonNullable<typeof window.hermesDesktop>

async function invokeNative<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')

  return invoke<T>(command, args)
}

const revealLogs: NonNullable<Bridge['revealLogs']> = async () =>
  invokeNative('logs_reveal')

const getRecentLogs: NonNullable<Bridge['getRecentLogs']> = async () =>
  invokeNative('logs_recent')

const logsRoot: NonNullable<Bridge['logsRoot']> = async () => invokeNative('logs_root')

/** Fire-and-forget — matches Electron `ipcRenderer.send` (no await on crash). */
const reportRendererError: NonNullable<Bridge['reportRendererError']> = report => {
  void invokeNative('report_renderer_error', { report }).catch(() => undefined)
}

export const logsBridge: Pick<
  Bridge,
  'revealLogs' | 'getRecentLogs' | 'logsRoot' | 'reportRendererError'
> = {
  revealLogs,
  getRecentLogs,
  logsRoot,
  reportRendererError
}
