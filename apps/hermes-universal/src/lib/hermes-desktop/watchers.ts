/**
 * Preview / plugin-root file watches over Rust `watchers.rs` (Electron
 * `watchPreviewFile`, `watchDirectory`, `stopPreviewFileWatch`,
 * `onPreviewFileChanged`).
 */

type Bridge = NonNullable<typeof window.hermesDesktop>

const EVENT = 'hermes://preview-file-changed'

async function invokeNative<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')

  return invoke<T>(command, args)
}

const watchPreviewFile: Bridge['watchPreviewFile'] = async url =>
  invokeNative('watch_preview_file', { url: String(url || '') })

const watchDirectory: NonNullable<Bridge['watchDirectory']> = async dir =>
  invokeNative('watch_directory', { dir: String(dir || '') })

const stopPreviewFileWatch: Bridge['stopPreviewFileWatch'] = async id =>
  invokeNative('stop_preview_file_watch', { id: String(id || '') })

const onPreviewFileChanged: Bridge['onPreviewFileChanged'] = callback => {
  let stopped = false
  let unlisten: (() => void) | undefined

  void import('@tauri-apps/api/event')
    .then(({ listen }) =>
      listen<{ id: string; path: string; url: string }>(EVENT, event => {
        callback(event.payload)
      })
    )
    .then(off => {
      if (stopped) {
        off()
      } else {
        unlisten = off
      }
    })
    .catch(() => {})

  return () => {
    stopped = true
    unlisten?.()
  }
}

export const watchersBridge: Pick<
  Bridge,
  'onPreviewFileChanged' | 'stopPreviewFileWatch' | 'watchDirectory' | 'watchPreviewFile'
> = {
  onPreviewFileChanged,
  stopPreviewFileWatch,
  watchDirectory,
  watchPreviewFile
}
