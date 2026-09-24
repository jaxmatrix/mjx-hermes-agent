/**
 * Preview capture + favicon + SSH loopback reach over Rust.
 */

import { $activeConnection } from '@/store/active-connection'

type Bridge = NonNullable<typeof window.hermesDesktop>

async function invokeNative<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')

  return invoke<T>(command, args)
}

const capturePreview: NonNullable<Bridge['capturePreview']> = async payload =>
  invokeNative('capture_preview', {
    rect: payload.rect ?? null,
    viewport: payload.viewport ?? null,
    webContentsId: payload.webContentsId ?? null,
    // Tauri's guest is named, not numbered — Electron's webContentsId is ignored.
    guestId: 'browser'
  })

const resolveFavicon: NonNullable<Bridge['resolveFavicon']> = async url =>
  invokeNative('resolve_favicon', { url: String(url || '') })

/** Rewrite a remote gateway's loopback URL through an SSH forward when possible. */
const reachPreviewUrl: NonNullable<Bridge['reachPreviewUrl']> = async url => {
  const target = String(url || '')

  if (!target) {
    return target
  }

  const active = $activeConnection.get()
  const scopeKey = active?.connection.sshScope ?? active?.scopeKey

  if (!scopeKey) {
    return target
  }

  try {
    const result = await invokeNative<{ url?: string }>('browser_reach_url', {
      url: target,
      scopeKey
    })

    return result?.url || target
  } catch {
    return target
  }
}

export const previewBridge: Pick<Bridge, 'capturePreview' | 'resolveFavicon' | 'reachPreviewUrl'> = {
  capturePreview,
  resolveFavicon,
  reachPreviewUrl
}
