/**
 * Cross-webview composer draft transport (MJXHRM-424) — Tauri event bus only.
 */

import { requestComposerDraftSync } from '@/lib/composer-draft-bus'
import { IS_TAURI } from '@/lib/platform'
import { addressesThisWindow, type WindowAddress } from '@/store/windows'

import { reloadPersistedDrafts, SESSION_DRAFTS_STORAGE_KEY } from './composer'

export const STASH_EVENT = 'composer-draft://changed'
const FLUSH_EVENT = 'composer-draft://flush'
const FLUSHED_EVENT = 'composer-draft://flushed'

const WEBVIEW_ORIGIN =
  typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `wv-${Math.random()}`

let lastAnnouncedSnapshot: null | string = null
let transportReady = false

function diskSnapshot(): string {
  try {
    return window.localStorage.getItem(SESSION_DRAFTS_STORAGE_KEY) ?? ''
  } catch {
    return ''
  }
}

/** After a local stash write, tell peer webviews to reload — unless nothing changed. */
export function noteComposerDraftPersisted(): void {
  if (!IS_TAURI) {
    return
  }

  const snapshot = diskSnapshot()

  if (snapshot === lastAnnouncedSnapshot) {
    return
  }

  lastAnnouncedSnapshot = snapshot

  void import('@tauri-apps/api/event').then(({ emit }) => emit(STASH_EVENT, { origin: WEBVIEW_ORIGIN }))
}

/** Peer webviews heard a stash change — refresh the in-memory map without re-announcing. */
export function absorbPeerDraftSnapshot(): void {
  lastAnnouncedSnapshot = diskSnapshot()
}

const PEER_FLUSH_TIMEOUT_MS = 5_000

export async function requestPeerComposerFlush(
  address: WindowAddress,
  timeoutMs: number = PEER_FLUSH_TIMEOUT_MS
): Promise<boolean> {
  if (!IS_TAURI) {
    return false
  }

  ensureTransport()

  const { emit, listen } = await import('@tauri-apps/api/event')
  const nonce = crypto.randomUUID()

  return await new Promise<boolean>(resolve => {
    let settled = false

    const finish = (ok: boolean) => {
      if (settled) {
        return
      }

      settled = true
      window.clearTimeout(timer)
      off?.()
      resolve(ok)
    }

    const timer = window.setTimeout(() => finish(false), timeoutMs)

    const offPromise = listen<{ nonce: string; origin: string }>(FLUSHED_EVENT, event => {
      if (event.payload?.nonce === nonce) {
        reloadPersistedDrafts()
        absorbPeerDraftSnapshot()
        finish(true)
      }
    })

    let off: (() => void) | undefined

    void offPromise.then(unsub => {
      off = () => {
        unsub()
      }

      if (settled) {
        unsub()
      }
    })

    void emit(FLUSH_EVENT, { ...address, nonce, origin: WEBVIEW_ORIGIN })
  })
}

function ensureTransport(): void {
  if (transportReady || !IS_TAURI) {
    return
  }

  transportReady = true
  lastAnnouncedSnapshot = diskSnapshot()

  void import('@tauri-apps/api/event').then(({ listen }) => {
    void listen<{ origin: string }>(STASH_EVENT, event => {
      if (event.payload?.origin === WEBVIEW_ORIGIN) {
        return
      }

      reloadPersistedDrafts()
      absorbPeerDraftSnapshot()
      requestComposerDraftSync('reload')
    })

    void listen<{ nonce: string; origin: string; surface: null | string; tile: null | string }>(
      FLUSH_EVENT,
      event => {
        const payload = event.payload

        if (!payload || payload.origin === WEBVIEW_ORIGIN || !addressesThisWindow(payload)) {
          return
        }

        requestComposerDraftSync('flush')

        void import('@tauri-apps/api/event').then(({ emit }) =>
          emit(FLUSHED_EVENT, { nonce: payload.nonce, origin: WEBVIEW_ORIGIN })
        )
      }
    )
  })
}

ensureTransport()
