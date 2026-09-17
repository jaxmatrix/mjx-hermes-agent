import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import { translateNow } from '@/i18n'
import { LOCAL_CONNECTION_ID } from '@/lib/backend-scope'
import { IS_MOBILE } from '@/lib/platform'
import { map } from '@/store/atom'
import { getInstallationId } from '@/store/installation-id'
import { dismissNotification, notify, notifyError } from '@/store/notifications'
import { attachSshPrompts, newAttemptId, onSshProgress, type SshStep } from '@/store/ssh-backend'
import { isActivityWindow, isSatelliteWindow } from '@/store/windows'

/**
 * Tunnels to local and SSH connections that are not the active one (MJXHRM-592).
 *
 * Rust owns the slot, its reconnect loop and its token (`src-tauri/src/tunnels.rs`).
 * This window holds ONE lease per connection however many callers acquire it,
 * and releases it when the last of them lets go. A destroyed window's leases
 * are reaped in Rust, so a missed release cannot outlive the window.
 *
 * What a consumer gets is a loopback base URL that can change (a redial binds
 * a new port — read it at dial time, reconnect on `onChange`), an
 * `instanceKey` that never does, and a `generation` that counts re-establishes.
 */

export interface TunnelDescriptor {
  connectionId: string
  baseUrl: string
  instanceKey: string
  generation: number
}

export type TunnelPhase = 'closed' | 'connecting' | 'failed' | 'ready' | 'retrying'

export interface TunnelStatus {
  connectionId: string
  phase: TunnelPhase
  errorKind?: string
  message?: string
  /** A failure retrying cannot fix without a person (locked, credentials, host key). */
  terminal: boolean
  generation: number
  instanceKey?: string
  /** The SSH step a background dial is on. */
  step?: SshStep
}

export interface TunnelError {
  kind: string
  message: string
  terminal: boolean
}

export interface TunnelLease {
  connectionId: string
  instanceKey: string
  baseUrl(): string
  /** The gateway socket URL. No token: Rust attaches it on `ws_open`. */
  wsUrl(): string
  generation(): number
  /** A redial moved the tunnel to a new base. */
  onChange(handler: (descriptor: TunnelDescriptor) => void): () => void
  /** The tunnel no longer serves this lease: closed, forgotten, or stopped on
   *  a failure only a person can answer. Re-acquire to use it again. */
  onClosed(handler: () => void): () => void
  release(): void
}

/** Every tunnel this window has heard about, by connection id. */
export const $tunnelStatus = map<Record<string, TunnelStatus>>({})

/** How often a held lease tells Rust it is still held (Rust drops it after 60 s). */
export const TOUCH_INTERVAL_MS = 20_000

/** "Needs sign-in": a background tunnel stopped on something only a person can answer. */
export function needsInteraction(status: null | TunnelStatus | undefined): boolean {
  return status?.phase === 'failed' && status.terminal
}

/** The failures a Connect can fix: unlock the device, answer a credential, trust a key. */
const SIGN_IN_KINDS = new Set(['credentials-needed', 'host-key-changed', 'locked'])

/** Whether `error` is a tunnel that needs a person to sign in. */
export function isTunnelSignInError(error: unknown): error is TunnelError {
  return typeof error === 'object' && error !== null && SIGN_IN_KINDS.has(String((error as Partial<TunnelError>).kind))
}

/** The attempt id Rust dials a background tunnel under, for its progress. */
export function tunnelAttemptId(connectionId: string): string {
  return `tunnel-${connectionId}`
}

interface Held {
  count: number
  leaseId: string
  descriptor: null | TunnelDescriptor
  /** Rust closed the slot under us (an edit, a removal, a hard stop). */
  closed: boolean
  pending: null | Promise<TunnelDescriptor>
  listeners: Set<(descriptor: TunnelDescriptor) => void>
  closedListeners: Set<() => void>
  subscribed: Promise<UnlistenFn[]>
  toucher: null | ReturnType<typeof setInterval>
}

const held = new Map<string, Held>()

function tunnelError(kind: string, message: string, terminal = true): TunnelError {
  return { kind, message, terminal }
}

function markClosed(entry: Held): void {
  entry.closed = true

  for (const handler of [...entry.closedListeners]) {
    try {
      handler()
    } catch {
      // One consumer failing to close must not starve the others.
    }
  }
}

function subscribe(connectionId: string, entry: Held): Promise<UnlistenFn[]> {
  return Promise.all([
    listen<TunnelDescriptor>(`tunnel://${connectionId}/changed`, event => {
      entry.descriptor = event.payload

      for (const handler of [...entry.listeners]) {
        try {
          handler(event.payload)
        } catch {
          // One consumer failing to reconnect must not starve the others.
        }
      }
    }),
    listen<TunnelStatus>(`tunnel://${connectionId}/status`, event => {
      $tunnelStatus.setKey(connectionId, event.payload)

      if (event.payload.phase === 'closed' || needsInteraction(event.payload)) {
        // The next acquire dials again rather than handing out a dead base.
        markClosed(entry)
      }
    }),
    onSshProgress(tunnelAttemptId(connectionId), progress => {
      const current = $tunnelStatus.get()[connectionId]

      if (current) {
        $tunnelStatus.setKey(connectionId, { ...current, step: progress.step })
      }
    })
  ]).catch(() => [])
}

async function dial(connectionId: string, entry: Held, interactive: boolean): Promise<TunnelDescriptor> {
  await entry.subscribed

  // An interactive dial asks under an attempt of its own, attached before the
  // invoke: Rust can ask for a passphrase in the first auth exchange.
  const attemptId = interactive ? newAttemptId() : null
  const detach = attemptId ? await attachSshPrompts(attemptId) : null

  try {
    const installationId = await getInstallationId()

    return await invoke<TunnelDescriptor>('tunnel_acquire', {
      attemptId,
      connectionId,
      installationId,
      interactive,
      leaseId: entry.leaseId
    })
  } finally {
    detach?.()
  }
}

function drop(connectionId: string, entry: Held): void {
  if (held.get(connectionId) === entry) {
    held.delete(connectionId)
  }

  if (entry.toucher) {
    clearInterval(entry.toucher)
    entry.toucher = null
  }

  void entry.subscribed.then(unlisten => unlisten.forEach(stop => stop()))
  void invoke('tunnel_release', { connectionId, leaseId: entry.leaseId }).catch(() => {})
}

/** Tell Rust the lease is still held, so a reload or a crash cannot leak it. */
function startTouching(connectionId: string, entry: Held): void {
  if (entry.toucher) {
    return
  }

  entry.toucher = setInterval(() => {
    void invoke<boolean>('tunnel_touch', { connectionId, leaseId: entry.leaseId })
      .then(known => {
        if (known === false) {
          markClosed(entry)
        }
      })
      .catch(() => {})
  }, TOUCH_INTERVAL_MS)
}

function leaseFor(connectionId: string, entry: Held): TunnelLease {
  const descriptor = () => entry.descriptor as TunnelDescriptor
  let released = false

  return {
    baseUrl: () => descriptor().baseUrl,
    connectionId,
    generation: () => descriptor().generation,
    instanceKey: descriptor().instanceKey,
    onChange(handler) {
      entry.listeners.add(handler)

      return () => entry.listeners.delete(handler)
    },
    onClosed(handler) {
      entry.closedListeners.add(handler)

      return () => entry.closedListeners.delete(handler)
    },
    release() {
      if (released) {
        return
      }

      released = true
      entry.count -= 1

      if (entry.count === 0) {
        drop(connectionId, entry)
      }
    },
    wsUrl: () => `${descriptor().baseUrl.replace(/^http/, 'ws')}/api/ws`
  }
}

function signInNotificationId(connectionId: string): string {
  return `tunnel-signin:${connectionId}`
}

/**
 * Say a background tunnel needs sign-in, once per connection (MJXHRM-592).
 *
 * Connect runs the interactive dial and only connects: the action that failed
 * is not re-run, because a rename, a delete or a Bot Mode send must never be
 * replayed on the user's behalf.
 */
function notifySignIn(connectionId: string, label: string): void {
  notify({
    action: {
      label: translateNow('settings.connections.tunnelConnect'),
      onClick: () => {
        void acquireTunnel(connectionId, { interactive: true, label })
          .then(lease => {
            // Signed in: the warning has done its job. A failed Connect leaves it
            // up to try again.
            dismissNotification(signInNotificationId(connectionId))
            lease.release()
          })
          .catch(error => {
            if (!isTunnelSignInError(error)) {
              notifyError(error, translateNow('settings.connections.tunnelSignInTitle', label))
            }
          })
      }
    },
    id: signInNotificationId(connectionId),
    kind: 'warning',
    message: translateNow('settings.connections.tunnelSignInMessage'),
    title: translateNow('settings.connections.tunnelSignInTitle', label)
  })
}

/**
 * Hold a tunnel to a local or SSH connection.
 *
 * `interactive` is the Connect of a tunnel that needs sign-in: it may prompt for
 * an unlock, a passphrase or a host key. Nothing else prompts; a background
 * acquire that needs a person raises the sign-in notification instead.
 */
export async function acquireTunnel(
  connectionId: string,
  options: { interactive?: boolean; label?: string } = {}
): Promise<TunnelLease> {
  if (IS_MOBILE && connectionId === LOCAL_CONNECTION_ID) {
    throw tunnelError('unsupported-platform', 'unsupported_platform')
  }

  // The HUD and the mobile activity screens hold no connections of their own.
  if (isSatelliteWindow() || isActivityWindow()) {
    throw tunnelError('unavailable', 'this window does not hold tunnels')
  }

  let entry = held.get(connectionId)

  if (!entry) {
    const created: Held = {
      closed: false,
      closedListeners: new Set(),
      count: 0,
      descriptor: null,
      leaseId: crypto.randomUUID(),
      listeners: new Set(),
      pending: null,
      subscribed: Promise.resolve([]),
      toucher: null
    }

    created.subscribed = subscribe(connectionId, created)
    held.set(connectionId, created)
    entry = created
  }

  const current = entry

  current.count += 1

  try {
    if (options.interactive || !current.descriptor || current.closed) {
      if (!current.pending || options.interactive) {
        const pending = dial(connectionId, current, options.interactive === true)

        current.pending = pending
        void pending
          .finally(() => {
            if (current.pending === pending) {
              current.pending = null
            }
          })
          .catch(() => {})
      }

      current.descriptor = await current.pending
      current.closed = false
    }
  } catch (error) {
    current.count -= 1

    if (current.count === 0) {
      drop(connectionId, current)
    }

    if (!options.interactive && isTunnelSignInError(error)) {
      notifySignIn(connectionId, options.label ?? connectionId)
    }

    throw error
  }

  startTouching(connectionId, current)

  const descriptor = current.descriptor as TunnelDescriptor

  if (!$tunnelStatus.get()[connectionId]) {
    $tunnelStatus.setKey(connectionId, {
      connectionId,
      generation: descriptor.generation,
      instanceKey: descriptor.instanceKey,
      phase: 'ready',
      terminal: false
    })
  }

  return leaseFor(connectionId, current)
}

/** The live base URL of a tunnel this window holds, if it holds one. */
export function liveTunnelBase(connectionId: string): null | string {
  return held.get(connectionId)?.descriptor?.baseUrl ?? null
}

/** Where `api({connectionId})` sends a call: the row's URL, else its live tunnel. */
export function connectionBase(rowUrl: null | string | undefined, connectionId: string): null | string {
  return rowUrl ?? liveTunnelBase(connectionId)
}

export const __testing = {
  reset(): void {
    for (const entry of held.values()) {
      if (entry.toucher) {
        clearInterval(entry.toucher)
      }
    }

    held.clear()
    $tunnelStatus.set({})
  }
}
