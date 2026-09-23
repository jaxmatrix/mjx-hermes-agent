/**
 * `openSessionInTerminal` over Rust `open_session_in_terminal` — Electron
 * `hermes:window:openInTerminal` / external-terminal.ts.
 */

type Bridge = NonNullable<typeof window.hermesDesktop>

async function invokeNative<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')

  return invoke<T>(command, args)
}

const openSessionInTerminal: NonNullable<Bridge['openSessionInTerminal']> = async (
  sessionId,
  opts
) => invokeNative('open_session_in_terminal', { sessionId, opts })

export const externalTerminalBridge: Pick<Bridge, 'openSessionInTerminal'> = {
  openSessionInTerminal
}
