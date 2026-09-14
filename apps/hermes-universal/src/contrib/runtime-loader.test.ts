/**
 * The loader pipeline (specifier rewrite, unsupported imports, SRI) and the disk
 * reconciliation loop driven by a fake `PluginDisk` — so the whole write→reload
 * behaviour is covered without Tauri or a gateway.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/store/notifications', () => ({ notify: vi.fn(), notifyError: vi.fn() }))

import type { DiskEntry, PluginDisk } from './plugin-disk'
import { $pluginDecisions, $pluginRecords, publishPlugin } from './plugins-store'
import { registry } from './registry'
import {
  __diskRecordFiles,
  __resetRuntimeLoaderForTests,
  loadRuntimePlugin,
  rootCappedDefault,
  scanDiskPlugins,
  shadowsBundledPlugin,
  unloadRuntimePlugin
} from './runtime-loader'

// jsdom can't `import()` a blob URL, so route the loader's blob back to a module
// this test controls. Keyed by the generated URL so parallel loads don't collide.
const modules = new Map<string, { default?: unknown }>()
let nextUrl = 0

beforeEach(() => {
  modules.clear()
  $pluginRecords.set({})
  $pluginDecisions.set({})
  __resetRuntimeLoaderForTests()

  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: (blob: Blob) => {
      const url = `blob:plugin/${nextUrl++}`
      // The loader passes the REWRITTEN source; keep it so tests can assert on it.
      modules.set(url, { default: undefined })
      void (blob as Blob & { __source?: string })

      return url
    },
    revokeObjectURL: () => {}
  })
})

afterEach(() => {
  __resetRuntimeLoaderForTests()
  vi.clearAllMocks()
})

// The real loader `import()`s the blob. Rather than fight jsdom, drive the disk
// half through a door whose sources are plugins we can express as ESM text, and
// assert the pipeline half on its observable output: the error records.
const rejectedError = (origin: string) => $pluginRecords.get()[origin]?.error ?? ''

describe('import specifier handling', () => {
  it('rejects a bare import the loader cannot resolve, naming it', async () => {
    await loadRuntimePlugin(`import x from 'lodash'\nexport default { id: 'a', register() {} }`, 'a')

    expect(rejectedError('a')).toContain('unsupported import')
    expect(rejectedError('a')).toContain('lodash')
  })

  it('lists every unresolvable specifier, not just the first', async () => {
    await loadRuntimePlugin(`import a from 'lodash'\nimport b from 'dayjs'\n`, 'multi')

    expect(rejectedError('multi')).toContain('lodash')
    expect(rejectedError('multi')).toContain('dayjs')
  })

  it('allows the SDK and react — the two specifiers the shims cover', async () => {
    await loadRuntimePlugin(
      `import { host } from '@hermes/plugin-sdk'\nimport React from 'react'\nimport { jsx } from 'react/jsx-runtime'\n`,
      'ok'
    )

    expect(rejectedError('ok')).not.toContain('unsupported import')
  })

  it('allows relative and URL specifiers', async () => {
    await loadRuntimePlugin(`import a from './util.js'\nimport b from 'https://x/y.js'\n`, 'rel')

    expect(rejectedError('rel')).not.toContain('unsupported import')
  })

  // The rewrite is anchored to import/export syntax, so a plugin mentioning
  // 'react' or 'lodash' in a plain string is untouched — that's the case that
  // matters, since rewriting a string would corrupt the plugin's own data.
  it('ignores specifier-looking string literals', async () => {
    await loadRuntimePlugin(
      `const label = 'lodash'\nhost.notify('react')\nexport default { id: 'strings', register() {} }`,
      'strings'
    )

    expect(rejectedError('strings')).not.toContain('unsupported import')
  })

  // Known limitation, shared with desktop: a regex can't tell a commented-out
  // import from a real one. Failing CLOSED is the right way round — the plugin
  // gets a named error instead of a silently-ignored dependency — but the message
  // will confuse someone who left dead code in their file.
  it('still flags a commented-out import (regex, not a parser)', async () => {
    await loadRuntimePlugin(`// import x from 'lodash'\nexport default { id: 'c', register() {} }`, 'commented')

    expect(rejectedError('commented')).toContain('lodash')
  })
})

describe('integrity', () => {
  const source = `export default { id: 'x', register() {} }`

  it('rejects a mismatched hash before evaluating anything', async () => {
    await loadRuntimePlugin(source, 'bad-sri', { integrity: 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' })

    expect(rejectedError('bad-sri')).toContain('integrity check failed')
  })

  it('rejects an unsupported algorithm rather than skipping the check', async () => {
    await loadRuntimePlugin(source, 'md5', { integrity: 'md5-abc' })

    expect(rejectedError('md5')).toContain('integrity check failed')
  })

  it('rejects a malformed integrity value', async () => {
    await loadRuntimePlugin(source, 'garbage', { integrity: 'sha256-' })

    expect(rejectedError('garbage')).toContain('integrity check failed')
  })
})

describe('failure handling', () => {
  it('records an error row instead of throwing, so one bad plugin is contained', async () => {
    await expect(loadRuntimePlugin(`import x from 'lodash'`, 'contained')).resolves.toBeNull()

    expect($pluginRecords.get().contained).toMatchObject({ kind: 'disk', status: 'error' })
  })

  // Keyed on the FILE, not the folder name: inventory rows are keyed by
  // `plugin.id`, and with two roots a folder name can equal a healthy plugin's
  // id in the other one. `name` still carries the folder so the settings page
  // reads the same.
  it('keys the error row on the entry file and still names the folder', async () => {
    await loadRuntimePlugin(`import x from 'lodash'`, 'my-folder', { file: '/root/my-folder/plugin.js' })

    const row = $pluginRecords.get()['/root/my-folder/plugin.js']

    expect(row.file).toBe('/root/my-folder/plugin.js')
    expect(row.name).toBe('my-folder')
  })

  // MJXHRM-455 D3. `loaded` is keyed by id and a second registration disposes
  // the first, so without this an installed agent package could take over a
  // first-party feature (445's Bot Mode) just by picking its slug.
  //
  // Asserted on the predicate rather than through `loadRuntimePlugin`: jsdom
  // cannot `import()` a blob, so every load in this file fails before reaching
  // the check (see the header).
  it('refuses a disk plugin that claims an in-tree plugin\u2019s id', () => {
    publishPlugin({ id: 'hermes-bots', kind: 'bundled', name: 'Bot Mode', status: 'loaded' })

    expect(shadowsBundledPlugin('hermes-bots', 'disk')).toBe(true)
    expect(shadowsBundledPlugin('hermes-bots', 'runtime')).toBe(true)
    // A bundled plugin re-registering itself is a reload, not a takeover.
    expect(shadowsBundledPlugin('hermes-bots', 'bundled')).toBe(false)
    // ...and a disk plugin with its own id is untouched.
    expect(shadowsBundledPlugin('kanban', 'disk')).toBe(false)
  })
})

describe('unloadRuntimePlugin', () => {
  it('is a no-op for an unknown id', () => {
    expect(() => unloadRuntimePlugin('never-loaded')).not.toThrow()
  })
})

// ── disk reconciliation ─────────────────────────────────────────────────────
// A fake door + a loadRuntimePlugin stub: what matters here is WHICH entries the
// scanner decides to (re)load and which records it drops, not the evaluation.

interface FakeFile {
  source: string
  stamp: string
}

const PACKAGE_PREFIX = 'agent-packages:'

/**
 * Map key → the entry the door lists.
 *
 * A bare `demo` is `desktop-plugins/demo/plugin.js` (on by default);
 * `agent-packages:demo` is `plugins/demo/desktop/plugin.js` (opt-in). Two roots
 * can carry the SAME folder name, which is why the loader keys its records on
 * the file rather than on the name — so the fixture has to be able to express
 * that collision.
 */
function fakeEntry(key: string, stamp: string): DiskEntry {
  const packaged = key.startsWith(PACKAGE_PREFIX)
  const name = packaged ? key.slice(PACKAGE_PREFIX.length) : key

  return packaged
    ? {
        defaultEnabled: false,
        file: `/root/plugins/${name}/desktop/plugin.js`,
        name,
        root: 'agent-packages',
        stamp
      }
    : { defaultEnabled: true, file: `/root/desktop-plugins/${name}/plugin.js`, name, root: 'desktop-plugins', stamp }
}

const entryKey = (entry: DiskEntry) =>
  entry.root === 'agent-packages' ? `${PACKAGE_PREFIX}${entry.name}` : entry.name

function fakeDoor(files: Map<string, FakeFile>, over: Partial<PluginDisk> = {}): PluginDisk {
  return {
    kind: 'local',
    hashToDetectChange: false,
    pollMs: 1_000,
    root: async () => '/root/desktop-plugins',
    list: async () => [...files.entries()].map(([key, file]) => fakeEntry(key, file.stamp)),
    read: async (entry: DiskEntry) => {
      const file = files.get(entryKey(entry))

      if (!file) {
        throw new Error('ENOENT')
      }

      return file.source
    },
    ...over
  }
}

/** A plugin whose registration we can observe through the registry. */
const pluginSource = (id: string) =>
  `export default { id: '${id}', register(ctx) { ctx.register({ area: 'panes', id: 'p', render: () => null }) } }`

describe('disk reconciliation', () => {
  it('reads each newly discovered folder exactly once', async () => {
    const files = new Map([['kanban', { source: pluginSource('kanban'), stamp: '1:1' }]])
    const door = fakeDoor(files)
    const read = vi.spyOn(door, 'read')

    await scanDiskPlugins(door)

    expect(read).toHaveBeenCalledOnce()
  })

  it('does not re-read an unchanged folder on the next tick', async () => {
    const files = new Map([['kanban', { source: pluginSource('kanban'), stamp: '1:1' }]])
    const door = fakeDoor(files)

    await scanDiskPlugins(door)
    const read = vi.spyOn(door, 'read')
    await scanDiskPlugins(door)

    expect(read).not.toHaveBeenCalled()
  })

  it('re-reads exactly once when the stamp changes', async () => {
    const files = new Map([['kanban', { source: pluginSource('kanban'), stamp: '1:1' }]])
    const door = fakeDoor(files)

    await scanDiskPlugins(door)

    files.set('kanban', { source: pluginSource('kanban'), stamp: '2:2' })
    const read = vi.spyOn(door, 'read')

    await scanDiskPlugins(door)
    expect(read).toHaveBeenCalledOnce()

    // …and stays quiet once the new stamp is recorded.
    read.mockClear()
    await scanDiskPlugins(door)
    expect(read).not.toHaveBeenCalled()
  })

  it('drops the inventory row when a folder vanishes', async () => {
    const files = new Map([['gone', { source: `import x from 'lodash'`, stamp: '1:1' }]])
    const door = fakeDoor(files)

    const key = '/root/desktop-plugins/gone/plugin.js'

    await scanDiskPlugins(door)
    expect($pluginRecords.get()[key]).toBeTruthy()

    files.delete('gone')
    await scanDiskPlugins(door)

    expect($pluginRecords.get()[key]).toBeUndefined()
  })

  it('re-reads a folder that reappears after being deleted', async () => {
    const files = new Map([['flap', { source: `import x from 'lodash'`, stamp: '1:1' }]])
    const door = fakeDoor(files)

    await scanDiskPlugins(door)
    files.delete('flap')
    await scanDiskPlugins(door)

    files.set('flap', { source: `import x from 'lodash'`, stamp: '1:1' })
    const read = vi.spyOn(door, 'read')
    await scanDiskPlugins(door)

    expect(read).toHaveBeenCalledOnce()
  })

  it('does nothing at all when there is no door', async () => {
    await expect(scanDiskPlugins(undefined)).resolves.toBeUndefined()
  })

  it('survives a door whose list() throws', async () => {
    const door = fakeDoor(new Map(), { list: async () => Promise.reject(new Error('offline')) })

    await expect(scanDiskPlugins(door)).resolves.toBeUndefined()
  })

  it('skips a folder whose read fails, leaving the rest to load', async () => {
    const files = new Map([
      ['ok', { source: `import x from 'lodash'`, stamp: '1:1' }],
      ['unreadable', { source: '', stamp: '1:1' }]
    ])

    const door = fakeDoor(files, {
      read: async (entry: DiskEntry) => {
        if (entry.name === 'unreadable') {
          throw new Error('EACCES')
        }

        return files.get(entryKey(entry))!.source
      }
    })

    await scanDiskPlugins(door)

    expect($pluginRecords.get()['/root/desktop-plugins/ok/plugin.js']).toBeTruthy()
    expect($pluginRecords.get()['/root/desktop-plugins/unreadable/plugin.js']).toBeUndefined()
  })

  // ── the two roots (MJXHRM-455) ────────────────────────────────────────────
  // `desktop-plugins/` is the user's own drop folder; `plugins/<n>/desktop/` is
  // the desktop half of whatever the gateway installed. Same door, same scan,
  // different posture — and folder names collide across them.

  describe('the unified agent-package root', () => {
    it('scans both roots in one pass', async () => {
      const files = new Map([
        ['local', { source: `import x from 'lodash'`, stamp: '1:1' }],
        [`${PACKAGE_PREFIX}installed`, { source: `import x from 'lodash'`, stamp: '1:1' }]
      ])

      await scanDiskPlugins(fakeDoor(files))

      expect(__diskRecordFiles()).toEqual([
        '/root/desktop-plugins/local/plugin.js',
        '/root/plugins/installed/desktop/plugin.js'
      ])
    })

    it('keeps the same folder name in both roots as TWO records', async () => {
      const files = new Map([
        ['demo', { source: `import x from 'lodash'`, stamp: '1:1' }],
        [`${PACKAGE_PREFIX}demo`, { source: `import x from 'lodash'`, stamp: '1:1' }]
      ])

      await scanDiskPlugins(fakeDoor(files))

      // Keyed by NAME, the second entry overwrote the first's record — so one of
      // them silently stopped being reconciled and never unloaded.
      expect(__diskRecordFiles()).toHaveLength(2)
    })

    it('unloads only the vanished root when the other still carries that name', async () => {
      const files = new Map([
        ['demo', { source: `import x from 'lodash'`, stamp: '1:1' }],
        [`${PACKAGE_PREFIX}demo`, { source: `import x from 'lodash'`, stamp: '1:1' }]
      ])

      const door = fakeDoor(files)

      await scanDiskPlugins(door)
      files.delete(`${PACKAGE_PREFIX}demo`)
      await scanDiskPlugins(door)

      expect(__diskRecordFiles()).toEqual(['/root/desktop-plugins/demo/plugin.js'])
    })

    it('does not clobber a HEALTHY plugin whose id is the other root\u2019s folder name', async () => {
      // The row a loaded plugin owns. Error rows used to be keyed by FOLDER
      // NAME, so a broken `plugins/demo/` overwrote this row and then took it
      // away again: still registered, invisible in Settings, no way to turn off.
      publishPlugin({ id: 'demo', kind: 'disk', name: 'Demo', status: 'loaded' })

      const files = new Map([[`${PACKAGE_PREFIX}demo`, { source: `import x from 'lodash'`, stamp: '1:1' }]])
      const door = fakeDoor(files)

      await scanDiskPlugins(door)
      expect($pluginRecords.get().demo).toMatchObject({ status: 'loaded' })

      files.delete(`${PACKAGE_PREFIX}demo`)
      await scanDiskPlugins(door)

      expect($pluginRecords.get().demo).toMatchObject({ status: 'loaded' })
    })

    it('still drops the error row when its folder goes away', async () => {
      const files = new Map([[`${PACKAGE_PREFIX}broken`, { source: `import x from 'lodash'`, stamp: '1:1' }]])
      const door = fakeDoor(files)
      const key = '/root/plugins/broken/desktop/plugin.js'

      await scanDiskPlugins(door)
      expect($pluginRecords.get()[key]).toMatchObject({ name: 'broken', status: 'error' })

      files.delete(`${PACKAGE_PREFIX}broken`)
      await scanDiskPlugins(door)

      expect($pluginRecords.get()[key]).toBeUndefined()
    })
  })

  describe('rootCappedDefault', () => {
    it('only ever LOWERS a plugin\u2019s own default', () => {
      // A package half cannot self-enable past its root's opt-in posture...
      expect(rootCappedDefault(true, false)).toBe(false)
      // ...and a permissive root cannot raise a plugin that declared itself off.
      expect(rootCappedDefault(false, true)).toBe(false)
      expect(rootCappedDefault(true, true)).toBe(true)
      expect(rootCappedDefault(false, false)).toBe(false)
    })

    it('reads absence on either side as "no opinion", not as off', () => {
      expect(rootCappedDefault(undefined, undefined)).toBe(true)
      expect(rootCappedDefault(undefined, true)).toBe(true)
      expect(rootCappedDefault(true, undefined)).toBe(true)
      expect(rootCappedDefault(undefined, false)).toBe(false)
    })
  })

  describe('a door with no stamp (the gateway door)', () => {
    const hashingDoor = (files: Map<string, FakeFile>) => fakeDoor(files, { hashToDetectChange: true, kind: 'rest' })

    it('hashes source to spot an edit the stamp cannot show', async () => {
      const files = new Map([['kanban', { source: `import a from 'lodash'`, stamp: '' }]])
      const door = hashingDoor(files)

      await scanDiskPlugins(door)

      // Same stamp ('') but different bytes — only a hash catches this.
      files.set('kanban', { source: `import b from 'dayjs'`, stamp: '' })
      await scanDiskPlugins(door)

      expect($pluginRecords.get()['/root/desktop-plugins/kanban/plugin.js'].error).toContain('dayjs')
    })

    it('does not reload when the source is byte-identical', async () => {
      const files = new Map([['kanban', { source: `import a from 'lodash'`, stamp: '' }]])
      const door = hashingDoor(files)

      await scanDiskPlugins(door)
      await scanDiskPlugins(door)

      const read = vi.spyOn(door, 'read')
      await scanDiskPlugins(door)

      // One read to hash, and no reload read on top of it.
      expect(read).toHaveBeenCalledOnce()
    })

    // The cap counts the COMBINED entry list, not one root's: two roots of 20
    // folders each is 40 HTTP reads every 10 s, which is exactly what the cap
    // exists to stop.
    it('reconciles membership only past the folder cap, counting BOTH roots', async () => {
      const files = new Map<string, FakeFile>([
        ...Array.from({ length: 15 }, (_, i): [string, FakeFile] => [
          `p${i}`,
          { source: `import x from 'lodash'`, stamp: '' }
        ]),
        ...Array.from({ length: 15 }, (_, i): [string, FakeFile] => [
          `${PACKAGE_PREFIX}q${i}`,
          { source: `import x from 'lodash'`, stamp: '' }
        ])
      ])

      const door = hashingDoor(files)

      await scanDiskPlugins(door)

      const read = vi.spyOn(door, 'read')
      await scanDiskPlugins(door)

      // No content hashing at this size — an in-place edit needs manual Rescan.
      expect(read).not.toHaveBeenCalled()

      // But a NEW folder still lands.
      files.set('late', { source: `import x from 'lodash'`, stamp: '' })
      await scanDiskPlugins(door)
      expect($pluginRecords.get()['/root/desktop-plugins/late/plugin.js']).toBeTruthy()
    })
  })

  afterEach(() => {
    for (const c of registry.getArea('panes')) {
      if (c.source?.startsWith('plugin:')) {
        registry.register({ ...c, enabled: false })
      }
    }
  })
})
