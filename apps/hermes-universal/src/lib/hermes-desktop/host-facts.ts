/**
 * Machine profile + remote-display reason over Rust `host_facts.rs`.
 */

type Bridge = NonNullable<typeof window.hermesDesktop>

async function invokeNative<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')

  return invoke<T>(command, args)
}

const getMachineProfile: NonNullable<Bridge['getMachineProfile']> = async () =>
  invokeNative('get_machine_profile')

const getRemoteDisplayReason: NonNullable<Bridge['getRemoteDisplayReason']> = async () =>
  invokeNative('get_remote_display_reason')

export const hostFactsBridge: Pick<Bridge, 'getMachineProfile' | 'getRemoteDisplayReason'> = {
  getMachineProfile,
  getRemoteDisplayReason
}
