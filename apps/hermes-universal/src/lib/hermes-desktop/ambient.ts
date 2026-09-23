/**
 * Cross-window ambient cue claims over Rust `ambient.rs` — Electron
 * `hermes:ambient:claim`.
 */

type Bridge = NonNullable<typeof window.hermesDesktop>

async function invokeNative<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')

  return invoke<T>(command, args)
}

const claimAmbientCue: NonNullable<Bridge['claimAmbientCue']> = async key =>
  invokeNative('claim_ambient_cue', { key })

export const ambientBridge: Pick<Bridge, 'claimAmbientCue'> = { claimAmbientCue }
