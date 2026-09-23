/**
 * Desktop plugin roots / source read / git probe-install-remove over Rust
 * `plugins_*` + `plugins_probe` / `plugins_install_desktop` /
 * `plugins_remove_desktop`.
 *
 * Electron’s `desktopPluginsRoot` + `readPluginSource` +
 * `reconcileDesktopPlugins` + `probePluginRepo` / `installDesktopPlugin` /
 * `removeDesktopPlugin`.
 *
 * `plugins_*` only accept a folder NAME (never an absolute path). The bridge
 * turns the Electron path-shaped `readPluginSource(file)` into a name + root
 * before invoking, and refuses anything outside the two known trees.
 */

type Bridge = NonNullable<typeof window.hermesDesktop>

type PluginRoot = 'agent-packages' | 'desktop-plugins'

async function invokeNative<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')

  return invoke<T>(command, args)
}

const desktopPluginsRoot: NonNullable<Bridge['desktopPluginsRoot']> = async () =>
  invokeNative<string>('plugins_root', { profile: null, root: 'desktop-plugins' })

/** Universal inventories both roots directly — no Electron-style copy-up. */
const reconcileDesktopPlugins: NonNullable<Bridge['reconcileDesktopPlugins']> = async () => []

function splitPath(filePath: string): string[] {
  return filePath.replace(/\\/g, '/').split('/').filter(Boolean)
}

/** Map an absolute entry path onto `{ name, root }` for `plugins_read`. */
export function resolvePluginEntry(filePath: string): { name: string; root: PluginRoot } | null {
  const parts = splitPath(filePath)

  if (parts.length < 2) {
    return null
  }

  const leaf = parts[parts.length - 1]
  const parent = parts[parts.length - 2]

  // …/desktop-plugins/<name>/plugin.js
  if (leaf === 'plugin.js' && parts.length >= 3) {
    const rootSeg = parts[parts.length - 3]

    if (rootSeg === 'desktop-plugins' && parent && !parent.includes('..')) {
      return { name: parent, root: 'desktop-plugins' }
    }
  }

  // …/plugins/<name>/desktop/plugin.js
  if (leaf === 'plugin.js' && parent === 'desktop' && parts.length >= 4) {
    const name = parts[parts.length - 3]
    const rootSeg = parts[parts.length - 4]

    if (rootSeg === 'plugins' && name && !name.includes('..')) {
      return { name, root: 'agent-packages' }
    }
  }

  return null
}

const readPluginSource: NonNullable<Bridge['readPluginSource']> = async filePath => {
  const resolved = resolvePluginEntry(String(filePath || ''))

  if (!resolved) {
    throw new Error('plugin source path is outside the local plugin roots')
  }

  const text = await invokeNative<string>('plugins_read', {
    profile: null,
    root: resolved.root,
    name: resolved.name
  })

  return {
    path: String(filePath),
    text,
    byteSize: new TextEncoder().encode(text).length,
    truncated: false
  }
}

const probePluginRepo: NonNullable<Bridge['probePluginRepo']> = async payload =>
  invokeNative('plugins_probe', {
    identifier: payload?.identifier,
    repo: payload?.repo
  })

const installDesktopPlugin: NonNullable<Bridge['installDesktopPlugin']> = async payload =>
  invokeNative('plugins_install_desktop', {
    identifier: payload?.identifier,
    repo: payload?.repo,
    force: payload?.force
  })

const removeDesktopPlugin: NonNullable<Bridge['removeDesktopPlugin']> = async payload =>
  invokeNative('plugins_remove_desktop', { name: String(payload?.name ?? '') })

export const pluginsBridge: Pick<
  Bridge,
  | 'desktopPluginsRoot'
  | 'reconcileDesktopPlugins'
  | 'readPluginSource'
  | 'probePluginRepo'
  | 'installDesktopPlugin'
  | 'removeDesktopPlugin'
> = {
  desktopPluginsRoot,
  reconcileDesktopPlugins,
  readPluginSource,
  probePluginRepo,
  installDesktopPlugin,
  removeDesktopPlugin
}
