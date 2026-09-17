import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import { LOCAL_CONNECTION_ID } from '@/lib/backend-scope'
import { IS_MOBILE } from '@/lib/platform'
import { map } from '@/store/atom'
import { getInstallationId } from '@/store/installation-id'
import { attachSshPrompts, onSshProgress, type SshStep } from '@/store/ssh-backend'
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
  onChange(handler: (descriptor: TunnelDescriptor) => void): () => void
  release(): void
}

/** Every tunnel this window has heard about, by connection id. */
export const $tunnelStatus = map<Record<string, TunnelStatus>>({})

/** "Needs sign-in": a background tunnel stopped on something only a person can answer. */
export function needsInteraction(status: null | TunnelStatus | undefined): boolean {
  return status?.phase === 'failed' && status.terminal
}

/** The attempt id Rust dials a tunnel under, for its progress and prompts. */
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
  subscribed: Promise<UnlistenFn[]>
}

const held = new Map<string, Held>()

function tunnelError(kind: string, message: string, terminal = true): TunnelError {
  return { kind, message, terminal }
}

function subscribe(connectionId: string, entry: Held): Promise<UnlistenFn[]> {
  return Promise.all([
    listen<TunnelDescriptor>(`tunnel://${connectionId}/changed`, event => {
      entry.descriptor = event.payload

      for (const handler of entry.listeners) {
        try {
          handler(event.payload)
        } catch {
          // One consumer failing to reconnect must not starve the others.
        }
      }
    }),
    listen<TunnelStatus>(`tunnel://${connectionId}/status`, event => {
      // The next acquire dials again rather than handing out a dead base.
      entry.closed = event.payload.phase === 'closed'
      $tunnelStatus.setKey(connectionId, event.payload)
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

  // Before the invoke: Rust can ask for a passphrase in the first auth exchange.
  const detach = interactive ? await attachSshPrompts(tunnelAttemptId(connectionId)) : null

  try {
    const installationId = await getInstallationId()

    return await invoke<TunnelDescriptor>('tunnel_acquire', {
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

  void entry.subscribed.then(unlisten => unlisten.forEach(stop => stop()))
  void invoke('tunnel_release', { connectionId, leaseId: entry.leaseId }).catch(() => {})
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

/**
 * Hold a tunnel to a local or SSH connection.
 *
 * `interactive` is the "Connect" of a tunnel that needs sign-in: it may prompt
 * for an unlock, a passphrase or a host key. Nothing else prompts.
 */
export async function acquireTunnel(
  connectionId: string,
  options: { interactive?: boolean } = {}
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
      count: 0,
      descriptor: null,
      leaseId: crypto.randomUUID(),
      listeners: new Set(),
      pending: null,
      subscribed: Promise.resolve([])
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

    throw error
  }

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
    held.clear()
    $tunnelStatus.set({})
  }
}
