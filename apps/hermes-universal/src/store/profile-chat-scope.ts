import { translateNow } from '@/i18n'
import { activeWorkFromLiveSessions, MAX_LISTED, mergeActiveWork } from '@/lib/active-work'
import { confirm } from '@/store/confirm'
import { $connection } from '@/store/connection'
import { requestGateway } from '@/store/gateway-client'
import { $gatewayMode } from '@/store/gateway-mode'
import { restartLocalBackend } from '@/store/local-backend'
import { notify } from '@/store/notifications'

/**
 * What happens to the LIVE CHAT when the app's profile changes — said out loud.
 *
 * Switching profile (`store/profiles` `setActiveProfile`) re-scopes every
 * profile-scoped REST call and every RPC that names no profile: config, skills,
 * tools, model, the session list, new chats. What does NOT move is a chat that
 * is already open: its session was built against the profile it started in.
 *
 * Local and SSH backends run the backend's unified server (MJXHRM-592), which
 * serves every profile by parameter, so a profile change needs no respawn:
 *
 *  * **local** — the backend is this device's child. A restart is still on
 *    offer, and it asks first when the backend is in the middle of something.
 *  * **ssh / remote / cloud** — the open chat stays put, so say that instead of
 *    implying it followed.
 *
 * Extracted from `app/gateway/profile-selector.tsx` (MJXHRM-389); the
 * wake-phrase router needs the identical answer.
 */
export function announceProfileChatScope(target: null | string): void {
  if (!$connection.get()) {
    // Nothing is connected: there is no live chat to be wrong about, and the
    // next connection opens under the profile just selected.
    return
  }

  const name = target ? `"${target}"` : 'the default profile'

  if ($gatewayMode.get() === 'local') {
    notify({
      action: {
        label: translateNow('settings.connections.profileRestartAction'),
        onClick: () => void restartLocalBackendConfirmed()
      },
      kind: 'info',
      message: translateNow('settings.connections.profileRestartMessage', target ?? 'default')
    })

    return
  }

  notify({
    kind: 'info',
    message: `Settings, skills and new chats now use ${name}. The open chat keeps the profile it was started in.`
  })
}

/**
 * "Restart backend": respawn the local child.
 *
 * Asks first when the backend is working — naming what, from its own
 * `session.active_list` (background sessions and Bot Mode rooms alike) — and
 * restarts silently when nothing is live, like upstream desktop's
 * `confirmSharedGatewayRestart`. Resolves whether the restart ran.
 */
export async function restartLocalBackendConfirmed(): Promise<boolean> {
  const listed = await requestGateway<{ sessions?: { status?: string; title?: string }[] }>(
    'session.active_list',
    {}
  ).catch(() => null)

  const work = mergeActiveWork([activeWorkFromLiveSessions(listed?.sessions ?? [])])

  if (work.count > 0) {
    const titles = work.titles.slice(0, MAX_LISTED)

    const answer = await confirm({
      cancelLabel: translateNow('common.cancel'),
      confirmLabel: translateNow('settings.connections.restartLocalConfirm'),
      description: translateNow('settings.connections.restartLocalDescription', titles, work.count - titles.length),
      destructive: true,
      title: translateNow('settings.connections.restartLocalTitle')
    })

    if (answer !== true) {
      return false
    }
  }

  // The child respawns in place and its tunnel leases move with it: the fold's
  // primary socket follows its lease, so there is nothing to reconnect here.
  await restartLocalBackend()

  return true
}
