/**
 * MCP OAuth loopback callback over Rust `mcp_oauth.rs` — Electron
 * `hermes:mcp-oauth:*` (mcp-oauth-callback-ipc.ts).
 */

type Bridge = NonNullable<typeof window.hermesDesktop>

async function invokeNative<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')

  return invoke<T>(command, args)
}

const listen: NonNullable<Bridge['mcpOauth']>['listen'] = async () => invokeNative('mcp_oauth_listen')

const wait: NonNullable<Bridge['mcpOauth']>['wait'] = async (id, timeoutMs) =>
  invokeNative('mcp_oauth_wait', { id, timeoutMs })

const cancel: NonNullable<Bridge['mcpOauth']>['cancel'] = async id => invokeNative('mcp_oauth_cancel', { id })

export const mcpOauthBridge: Pick<Bridge, 'mcpOauth'> = {
  mcpOauth: { listen, wait, cancel }
}
