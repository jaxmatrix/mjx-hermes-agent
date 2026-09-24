/**
 * `saveGatewayFile` — Electron streaming download + Save dialog.
 *
 * Universal already streams through Rust `download_file` against the active
 * media target (`media_set_target`). Callers pass the active connection’s
 * path (`lib/media.ts`); this picks a destination and writes there.
 */

type Bridge = NonNullable<typeof window.hermesDesktop>

function basename(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, '')
  const parts = trimmed.split(/[/\\]/)

  return parts[parts.length - 1] || 'download'
}

const saveGatewayFile: NonNullable<Bridge['saveGatewayFile']> = async payload => {
  const { invoke } = await import('@tauri-apps/api/core')
  const { save } = await import('@tauri-apps/plugin-dialog')

  const suggested =
    (payload.suggestedName || '').trim() || basename(payload.path) || 'download'

  const dest = await save({
    defaultPath: suggested,
    title: 'Save File'
  })

  if (!dest) {
    return { canceled: true, saved: false }
  }

  await invoke('download_file', { path: payload.path, dest })

  return { saved: true, path: dest }
}

export const gatewayFileBridge: Pick<Bridge, 'saveGatewayFile'> = { saveGatewayFile }
