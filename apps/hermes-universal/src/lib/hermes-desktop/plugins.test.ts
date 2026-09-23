import { describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  calls: [] as [string, Record<string, unknown> | undefined][]
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
    native.calls.push([command, args])

    if (command === 'plugins_root') {
      return '/home/u/.hermes/desktop-plugins'
    }

    if (command === 'plugins_read') {
      return 'export default { id: "demo" }'
    }

    if (command === 'plugins_probe') {
      return { ok: true, agent: false, desktop: true, warnings: [], insecure: false }
    }

    if (command === 'plugins_install_desktop') {
      return { ok: true, pluginName: 'demo', path: '/home/u/.hermes/desktop-plugins/demo' }
    }

    if (command === 'plugins_remove_desktop') {
      return { ok: true, path: '/home/u/.hermes/desktop-plugins/demo' }
    }

    return undefined
  })
}))

import { pluginsBridge, resolvePluginEntry } from './plugins'

describe('resolvePluginEntry', () => {
  it('accepts desktop-plugins and agent-package entry paths', () => {
    expect(resolvePluginEntry('/home/u/.hermes/desktop-plugins/demo/plugin.js')).toEqual({
      name: 'demo',
      root: 'desktop-plugins'
    })
    expect(resolvePluginEntry('/home/u/.hermes/plugins/pkg/desktop/plugin.js')).toEqual({
      name: 'pkg',
      root: 'agent-packages'
    })
  })

  it('rejects paths outside the two roots', () => {
    expect(resolvePluginEntry('/etc/passwd')).toBeNull()
    expect(resolvePluginEntry('/home/u/.hermes/desktop-plugins/../secrets/plugin.js')).toBeNull()
  })
})

describe('hermesDesktop plugin roots', () => {
  it('desktopPluginsRoot / readPluginSource / reconcileDesktopPlugins', async () => {
    native.calls = []

    await expect(pluginsBridge.desktopPluginsRoot!()).resolves.toBe('/home/u/.hermes/desktop-plugins')
    await expect(pluginsBridge.reconcileDesktopPlugins!()).resolves.toEqual([])
    await expect(
      pluginsBridge.readPluginSource!('/home/u/.hermes/desktop-plugins/demo/plugin.js')
    ).resolves.toMatchObject({
      text: 'export default { id: "demo" }',
      truncated: false,
      path: '/home/u/.hermes/desktop-plugins/demo/plugin.js'
    })

    expect(native.calls).toEqual([
      ['plugins_root', { profile: null, root: 'desktop-plugins' }],
      [
        'plugins_read',
        { profile: null, root: 'desktop-plugins', name: 'demo' }
      ]
    ])
  })

  it('probe / install / remove delegate to the git helpers', async () => {
    native.calls = []

    await expect(pluginsBridge.probePluginRepo!({ identifier: 'acme/demo' })).resolves.toMatchObject({
      ok: true,
      desktop: true
    })
    await expect(pluginsBridge.installDesktopPlugin!({ identifier: 'acme/demo', force: true })).resolves.toMatchObject({
      ok: true,
      pluginName: 'demo'
    })
    await expect(pluginsBridge.removeDesktopPlugin!({ name: 'demo' })).resolves.toMatchObject({
      ok: true,
      path: '/home/u/.hermes/desktop-plugins/demo'
    })

    expect(native.calls).toEqual([
      ['plugins_probe', { identifier: 'acme/demo', repo: undefined }],
      ['plugins_install_desktop', { identifier: 'acme/demo', repo: undefined, force: true }],
      ['plugins_remove_desktop', { name: 'demo' }]
    ])
  })
})
