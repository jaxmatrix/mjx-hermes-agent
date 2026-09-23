/**
 * Two Electron levers over the backend a window is on.
 *
 * `revalidateConnection` exists because Electron CACHES the primary's
 * descriptor, and a remote that died across a sleep has no child process whose
 * exit would clear it. Nothing is cached here: every `getConnection` resolves
 * the row and re-acquires its tunnel (`./connections`, `primaryDial`), and Rust's
 * tunnel book notices a dead SSH session by itself. So the truthful answer is
 * always "nothing was rebuilt" — what Electron answers for a local backend.
 *
 * `recycleBackend` is desktop's recovery from a backend running older code than
 * its files (a 503 on the Models page):
 *
 *  • local  — respawn the child in place (`local_backend_restart`). One child
 *    serves every window, so a busy one asks first, as universal's own "Restart
 *    backend" does; declining resolves, and desktop simply re-reads.
 *  • remote / cloud — not ours to restart. Electron drops its socket and
 *    re-dials; here that is the soft switch `onConnectionApplied` drives.
 *  • SSH — refused: `ssh_disconnect` leaves the remote serve running by design,
 *    so nothing here can replace it, and saying it restarted would be a lie.
 */

import { emitConnectionApplied } from './connection-applied'
import { settingsCopy } from './registry'

type Bridge = NonNullable<typeof window.hermesDesktop>

export const backendBridge: Pick<Bridge, 'revalidateConnection'> & Required<Pick<Bridge, 'recycleBackend'>> = {
  revalidateConnection: async () => ({ ok: true, rebuilt: false }),

  recycleBackend: async () => {
    // Dynamic: both reach `@/hermes`.
    const { $activeConnection } = await import('@/store/active-connection')
    const kind = $activeConnection.get()?.kind

    if (kind === 'ssh') {
      throw new Error(settingsCopy().connections.sshRestartUnsupported)
    }

    if (kind === 'local') {
      const { restartLocalBackendConfirmed } = await import('@/store/profile-chat-scope')

      await restartLocalBackendConfirmed()
    } else if (kind) {
      emitConnectionApplied()
    }

    return { ok: true }
  }
}
