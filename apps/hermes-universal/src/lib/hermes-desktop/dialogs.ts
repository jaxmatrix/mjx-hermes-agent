/**
 * `selectPaths` and `selectSavePath`: the OS pickers, over `tauri-plugin-dialog`
 * (`dialog:allow-open` / `dialog:allow-save`).
 *
 * Electron's answers, kept: an open that was dismissed is `[]`, a save that was
 * dismissed is `null`. `profile` is Electron's Windows-host/WSL-backend path
 * bridge and has nothing to translate here. No title is invented — Electron's
 * English default would be the one untranslated string in the dialog.
 *
 * On Android a picked file is a `content://` URI, which is what
 * `readFileDataUrl` reads.
 */

type Bridge = NonNullable<typeof window.hermesDesktop>

const selectPaths: Bridge['selectPaths'] = async (options = {}) => {
  const { open } = await import('@tauri-apps/plugin-dialog')

  const picked = await open({
    defaultPath: options.defaultPath || undefined,
    directory: options.directories === true,
    filters: Array.isArray(options.filters) ? options.filters : undefined,
    // Electron's default: several, unless the caller says one.
    multiple: options.multiple !== false,
    title: options.title || undefined
  })

  return picked === null ? [] : Array.isArray(picked) ? picked : [picked]
}

const selectSavePath: NonNullable<Bridge['selectSavePath']> = async (options = {}) => {
  const { save } = await import('@tauri-apps/plugin-dialog')

  return (
    (await save({
      defaultPath: options.defaultPath || undefined,
      filters: Array.isArray(options.filters) ? options.filters : undefined,
      title: options.title || undefined
    })) || null
  )
}

export const dialogsBridge: Pick<Bridge, 'selectPaths' | 'selectSavePath'> = { selectPaths, selectSavePath }
