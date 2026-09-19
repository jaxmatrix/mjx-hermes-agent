import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import { tunnelErrorMessage } from '@/app/gateway/ssh-copy'
import { translateNow, type Translations } from '@/i18n'
import { TRANSLATIONS } from '@/i18n/catalog'
import { getRuntimeI18nLocale } from '@/i18n/runtime'
import { LOCAL_CONNECTION_ID } from '@/lib/backend-scope'
import { IS_MOBILE, IS_TAURI } from '@/lib/platform'
import { map } from '@/store/atom'
import { getInstallationId } from '@/store/installation-id'
import { dismissNotification, notify, notifyError } from '@/store/notifications'
import { keptSshAnswer, type KeptSshAnswer } from '@/store/ssh-answers'
import {
  addSshPromptAnswerListener,
  attachSshPrompts,
  newAttemptId,
  onSshProgress,
  type SshStep
} from '@/store/ssh-backend'
import { isHudWindow, isSatelliteWindow } from '@/store/windows'

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
  /** The SSH step a background dial is on, and how far along that is (0–1). */
  step?: SshStep
  fraction?: number
}

export interface TunnelError {
  kind: string
  message: string
  terminal: boolean
  /** The SSH failure it came from, when there was one; picks localized copy. */
  sshKind?: string
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

/** "Needs sign-in": a background tunnel stopped on something only a person can answer. */
export function needsInteraction(status: null | TunnelStatus | undefined): boolean {
  return status?.phase === 'failed' && status.terminal
}

/** The failures a Connect can fix: unlock the device, or answer a credential. A
 *  CHANGED host key is not one — no policy accepts it — and has its own warning. */
const SIGN_IN_KINDS = new Set(['credentials-needed', 'locked'])

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
        $tunnelStatus.setKey(connectionId, { ...current, fraction: progress.fraction, step: progress.step })
      }
    })
  ]).catch(() => [])
}

/**
 * Whether this window dials at all. Every dial is a lease, the primary's
 * included, so a window with a gateway of its own holds tunnels: the shells,
 * a tile, the HUD and a mobile activity screen — Rust reaps a destroyed
 * window's leases by its label, whatever kind it is. Quick Entry, the wake
 * indicator and the other satellites hand off to a window that does.
 */
function holdsTunnels(): boolean {
  return !isSatelliteWindow() || isHudWindow()
}

let pageOpen: null | Promise<number> = null

/**
 * This page declares its start and gets the epoch its holds carry (MJXHRM-592).
 * Rust ends every hold an earlier page of the window took, and refuses a hold
 * whose page has since reloaded or closed, so a late command from a gone page
 * cannot leave a hold nothing would ever end. One open per page; a failure is
 * never kept, so the next acquire asks again.
 */
function ensurePageOpen(): Promise<number> {
  if (!pageOpen) {
    const opening = invoke<unknown>('tunnel_page_open').then(epoch => {
      if (typeof epoch !== 'number') {
        throw tunnelError('unavailable', 'this page has no tunnel epoch')
      }

      return epoch
    })

    pageOpen = opening
    opening.catch(() => {
      if (pageOpen === opening) {
        pageOpen = null
      }
    })
  }

  return pageOpen
}

/**
 * Window boot: the page declares its start before anything else can acquire,
 * so a reloaded or recreated page ends the previous page's holds even if it
 * never takes one of its own. A window that holds no tunnels (`holdsTunnels`)
 * never opens one. A failure here is retried by the first acquire, which awaits
 * the same open.
 */
export function openTunnelPage(): void {
  if (!IS_TAURI || !holdsTunnels()) {
    return
  }

  void ensurePageOpen().catch(() => {})
}

async function dial(
  connectionId: string,
  entry: Held,
  interactive: boolean,
  attemptId: null | string
): Promise<TunnelDescriptor> {
  await entry.subscribed

  // An interactive dial asks under an attempt of its own, attached before the
  // invoke: Rust can ask for a passphrase in the first auth exchange.
  const detach = attemptId ? await attachSshPrompts(attemptId) : null

  try {
    // Awaited before the acquire: the epoch has to exist before any hold does.
    const [installationId, pageEpoch] = await Promise.all([getInstallationId(), ensurePageOpen()])

    return await invoke<TunnelDescriptor>('tunnel_acquire', {
      attemptId,
      connectionId,
      installationId,
      interactive,
      leaseId: entry.leaseId,
      pageEpoch
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

function gatewayCopy(): Translations['settings']['gateway'] {
  return TRANSLATIONS[getRuntimeI18nLocale()].settings.gateway
}

function errorKind(error: unknown): string {
  return typeof error === 'object' && error !== null ? String((error as Partial<TunnelError>).kind) : ''
}

/** The answers a Connect gives are kept where that connection's dials read them. */
type TunnelAnswerSaver = (connectionId: string, answer: KeptSshAnswer) => Promise<unknown>

let answerSaver: null | TunnelAnswerSaver = null

/**
 * Where Connect keeps a passphrase or password answer. A registration hook,
 * like `setConnectionBaseResolver`: the registry store owns the write and
 * imports this module, so it registers here instead of being imported.
 */
export function setTunnelAnswerSaver(saver: TunnelAnswerSaver): () => void {
  const previous = answerSaver

  answerSaver = saver

  return () => {
    if (answerSaver === saver) {
      answerSaver = previous
    }
  }
}

function hostKeyNotificationId(connectionId: string): string {
  return `tunnel-hostkey:${connectionId}`
}

/**
 * A changed host key: no policy accepts one, so there is nothing to Connect.
 * Says what the configurator says, with Rust's `ssh-keygen -R` guidance. The
 * fix happens outside the app and Rust dials this connection in the background
 * no more until a person asks, so Retry is that ask: the interactive dial.
 */
function notifyHostKeyChanged(connectionId: string, label: string, error: unknown): void {
  notify({
    action: {
      label: translateNow('common.retry'),
      onClick: () => void connectTunnel(connectionId, label)
    },
    detail: (error as Partial<TunnelError>).message,
    id: hostKeyNotificationId(connectionId),
    kind: 'error',
    message: tunnelErrorMessage(error, gatewayCopy()),
    title: label
  })
}

/** A background acquire failed: say so only when a person can act on it. */
function notifyBackgroundFailure(connectionId: string, label: string, error: unknown): void {
  if (errorKind(error) === 'host-key-changed') {
    notifyHostKeyChanged(connectionId, label, error)
  } else if (isTunnelSignInError(error)) {
    notifySignIn(connectionId, label)
  }
}

/**
 * The Connect of a tunnel that needs sign-in (MJXHRM-592).
 *
 * Runs the interactive dial and only connects: the action that failed is not
 * re-run, because a rename, a delete or a Bot Mode send must never be replayed
 * on the user's behalf. A passphrase or password answered on THIS dial is kept
 * (the configurator's rules), so the next background dial authenticates.
 */
export async function connectTunnel(connectionId: string, label: string): Promise<void> {
  const attemptId = newAttemptId()

  const keep = addSshPromptAnswerListener((prompt, answer) => {
    const kept = prompt.attemptId === attemptId ? keptSshAnswer(prompt.kind, answer) : null

    if (kept && answerSaver) {
      void answerSaver(connectionId, kept).catch(() => {})
    }
  })

  try {
    const lease = await acquireTunnel(connectionId, { attemptId, interactive: true, label })

    // Connected: whichever warning asked for this has done its job.
    dismissNotification(signInNotificationId(connectionId))
    dismissNotification(hostKeyNotificationId(connectionId))
    lease.release()
  } catch (error) {
    const kind = errorKind(error)

    if (kind === 'cancelled') {
      // The person dismissed the question. The warning stays for another try.
      return
    }

    if (kind === 'host-key-changed') {
      notifyHostKeyChanged(connectionId, label, error)
    } else if (isTunnelSignInError(error)) {
      notifySignIn(connectionId, label, tunnelErrorMessage(error, gatewayCopy()))
    } else {
      notifyError(
        tunnelErrorMessage(error, gatewayCopy()),
        translateNow('settings.connections.tunnelSignInTitle', label)
      )
    }
  } finally {
    keep()
  }
}

/** Say a background tunnel needs sign-in, once per connection. */
function notifySignIn(connectionId: string, label: string, detail?: string): void {
  notify({
    action: {
      label: translateNow('settings.connections.tunnelConnect'),
      onClick: () => void connectTunnel(connectionId, label)
    },
    detail,
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
  options: { attemptId?: string; interactive?: boolean; label?: string } = {}
): Promise<TunnelLease> {
  if (IS_MOBILE && connectionId === LOCAL_CONNECTION_ID) {
    throw tunnelError('unsupported-platform', 'unsupported_platform')
  }

  if (!holdsTunnels()) {
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
        const interactive = options.interactive === true
        const attemptId = interactive ? (options.attemptId ?? newAttemptId()) : null
        const pending = dial(connectionId, current, interactive, attemptId)

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

    if (!options.interactive) {
      notifyBackgroundFailure(connectionId, options.label ?? connectionId, error)
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
    pageOpen = null
    held.clear()
    $tunnelStatus.set({})
  }
}
