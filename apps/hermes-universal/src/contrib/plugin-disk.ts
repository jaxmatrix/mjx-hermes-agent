/**
 * The runtime plugin DOOR — where `plugin.js` files come from. Two
 * implementations behind one interface, so the loader (runtime-loader.ts) never
 * knows which it is talking to.
 *
 *  LOCAL  (`kind: 'local'`) — this device's HERMES_HOME, read through the narrow
 *         Rust commands in src-tauri/src/plugins.rs. Resolved from THIS
 *         machine's HERMES_HOME, never the connected backend's `hermes_home`
 *         (desktop bug #66899) — a remote backend must not be able to point the
 *         local loader at its own files.
 *  REST   (`kind: 'rest'`) — the same tree on the machine running the GATEWAY,
 *         over `/api/fs/*` via lib/desktop-fs. This is how a plugin authored on
 *         a host reaches a phone, which has no local root at all.
 *
 * Each door reads TWO ROOTS under `$HERMES_HOME[/profiles/<p>]`:
 *
 *  `desktop-plugins/<name>/plugin.js`      — the user's own drop folder, ON by
 *                                            default: they put it there.
 *  `plugins/<name>/desktop/plugin.js`      — the desktop half of a unified agent
 *                                            package, i.e. whatever
 *                                            `plugins.manage{action:"install"}`
 *                                            cloned. Inventoried but INERT until
 *                                            allowlisted (GHSA-mcfc-hp25-cjv7):
 *                                            the python half is opt-in, so this
 *                                            one is too.
 *
 * The second root is why installing a plugin needs no client-side git — and, on
 * a phone, it is the ONLY way a desktop half can arrive at all.
 *
 * SECURITY / TRUST: neither door is a capability boundary — see runtime-loader.ts.
 * The REST door additionally means running code the CONNECTED BACKEND supplied.
 * That is a deliberate product decision (plugins should work on mobile without a
 * sideload), it is the fallback rather than the preference, and it is switchable
 * off in Settings ▸ Plugins.
 *
 * Change detection differs between the two, and the loader must not care:
 *   • local compares `stamp` (mtime:size) — one IPC call per tick, no file reads
 *     unless something actually changed;
 *   • REST has no mtime to compare (`FsEntry` carries none), so `stamp` is empty
 *     and the loader falls back to hashing fetched source. That costs one
 *     read-text per plugin per tick, which is why REST polls slower and stops
 *     content-diffing past a folder cap.
 * FIXME(MJX-53/mtime): `mtime` in the backend's `/api/fs/list` response would
 * collapse the REST door onto the same cheap path.
 */

import { invoke } from '@tauri-apps/api/core'

import { getStatus } from '@/hermes'
import { readDesktopDir, readDesktopFileText } from '@/lib/desktop-fs'
import { Codecs, persistentAtom } from '@/lib/persisted'
import { IS_DESKTOP } from '@/lib/platform'
import { revealPathInFileManager } from '@/lib/reveal-path'
import { $connection } from '@/store/connection'
import { $activeProfile } from '@/store/profiles'

/** Poll cadence per door. Local is an IPC stat; REST is N HTTP reads. */
export const LOCAL_POLL_MS = 2_000
export const REST_POLL_MS = 10_000

/** Past this many folders the REST door reconciles MEMBERSHIP only (added and
 *  removed plugins), and hot reload is manual via Rescan — a content hash per
 *  folder per tick over the network stops being a background cost. */
export const REST_CONTENT_DIFF_CAP = 24

/** The REST door is the FALLBACK, on by default so plugins authored on a host
 *  reach a phone with no setup. Switchable off in Settings ▸ Plugins: it means
 *  running code the connected backend supplied, with the app's full authority. */
export const $restDoorEnabled = persistentAtom('hermes.plugin.restDoor.enabled', true, Codecs.bool)

/** Which root an entry came from. The literals are the Rust enum's serde
 *  spelling (`plugins.rs` `PluginRoot`, kebab-case) — they go on the wire. */
export type PluginRoot = 'agent-packages' | 'desktop-plugins'

export const PLUGIN_ROOTS: readonly PluginRoot[] = ['desktop-plugins', 'agent-packages']

/** The posture a root gives the plugins in it. Only ever LOWERS a plugin's own
 *  `defaultEnabled` (see `runtime-loader.ts`), so a package cannot self-enable
 *  past the root it was installed into. */
export const ROOT_DEFAULT_ENABLED: Record<PluginRoot, boolean> = {
  'agent-packages': false,
  'desktop-plugins': true
}

export interface DiskEntry {
  /** Folder name — the plugin's identity ON DISK (its `plugin.id` may differ).
   *  NOT unique across roots: `desktop-plugins/demo` and `plugins/demo` are two
   *  different plugins, which is why the loader keys records on `file`. */
  name: string
  /** Absolute entry-file path — display, reveal, and the loader's record KEY. */
  file: string
  /** Opaque change token; '' means "this door can't tell" (see the header). */
  stamp: string
  root: PluginRoot
  /** The root's posture, capping the plugin's own `defaultEnabled`. */
  defaultEnabled: boolean
}

export interface PluginDisk {
  kind: 'local' | 'rest'
  /** Absolute root, for the settings page. */
  root(): Promise<string>
  list(): Promise<DiskEntry[]>
  read(entry: DiskEntry): Promise<string>
  /** Local only — a gateway path means nothing to this device's file manager. */
  reveal?: (path: string) => Promise<void>
  /** Poll interval this door can afford. */
  pollMs: number
  /** Whether the loader should hash source to spot edits (no usable `stamp`). */
  hashToDetectChange: boolean
}

interface RustPluginDirEntry {
  name: string
  file: string
  root: PluginRoot
  mtime_ms: number
  size: number
}

/** The profile whose plugin root applies: the live connection's, else the app's
 *  selection. Switching profiles changes the root, so the loader re-resolves. */
function activeProfile(): null | string {
  return $connection.get()?.profile ?? $activeProfile.get() ?? null
}

function localDisk(): PluginDisk {
  const profile = activeProfile()

  return {
    kind: 'local',
    hashToDetectChange: false,
    pollMs: LOCAL_POLL_MS,
    reveal: revealPathInFileManager,
    // The PRIMARY root, which is the one the settings page offers to reveal and
    // the one a user drops a plugin into.
    root: () => invoke<string>('plugins_root', { profile, root: 'desktop-plugins' }),
    list: async () => {
      // SERIAL across roots, deliberately: parallelising two `read_dir` invokes
      // saves a couple of milliseconds and doubles the chance of a torn
      // inventory mid-reconcile.
      const found: DiskEntry[] = []

      for (const root of PLUGIN_ROOTS) {
        const entries = await invoke<RustPluginDirEntry[]>('plugins_list', { profile, root })

        for (const entry of entries) {
          found.push({
            defaultEnabled: ROOT_DEFAULT_ENABLED[root],
            file: entry.file,
            name: entry.name,
            root,
            stamp: `${entry.mtime_ms}:${entry.size}`
          })
        }
      }

      return found
    },
    read: entry => invoke<string>('plugins_read', { name: entry.name, profile, root: entry.root })
  }
}

/** The gateway machine's hermes home. `hermes_home` comes from the status
 *  payload; an older backend that omits it means this door is unavailable, which
 *  the settings page reports rather than showing an empty inventory. */
async function restHome(): Promise<string> {
  const status = await getStatus()
  const home = status.hermes_home?.trim()

  if (!home) {
    throw new Error('the connected backend did not report its hermes_home')
  }

  return home.replace(/[/\\]+$/, '')
}

/** Directory and entry path per root — the TS twin of `plugins.rs`'s
 *  `PluginRoot::{dir,entry}`. Kept beside each other so the two halves of one
 *  layout cannot drift apart. */
const REST_ROOT_LAYOUT: Record<PluginRoot, { dir: string; entry: string }> = {
  'agent-packages': { dir: 'plugins', entry: 'desktop/plugin.js' },
  'desktop-plugins': { dir: 'desktop-plugins', entry: 'plugin.js' }
}

/** The primary root, for the settings page's "where am I reading from". */
async function restRoot(): Promise<string> {
  return `${await restHome()}/${REST_ROOT_LAYOUT['desktop-plugins'].dir}`
}

async function restList(home: string, root: PluginRoot): Promise<DiskEntry[]> {
  const layout = REST_ROOT_LAYOUT[root]
  const base = `${home}/${layout.dir}`
  const listing = await readDesktopDir(base)

  // A missing root is "no plugins", not a failure — same as the local door, and
  // the `plugins/` root legitimately does not exist until something is installed.
  if (listing.error) {
    return []
  }

  const found: DiskEntry[] = []

  for (const entry of listing.entries) {
    if (!entry.isDirectory || entry.name.startsWith('.')) {
      continue
    }

    const file = `${base}/${entry.name}/${layout.entry}`

    // Probe: a folder with no readable entry file is not a plugin for THIS root.
    // Under `plugins/` that is the common case — most agent packages are python
    // only — so it must be a skip, never an error.
    try {
      await readDesktopFileText(file)
    } catch {
      continue
    }

    found.push({ defaultEnabled: ROOT_DEFAULT_ENABLED[root], file, name: entry.name, root, stamp: '' })
  }

  return found.sort((a, b) => a.name.localeCompare(b.name))
}

function restDisk(): PluginDisk {
  return {
    kind: 'rest',
    hashToDetectChange: true,
    pollMs: REST_POLL_MS,
    root: restRoot,
    list: async () => {
      const home = await restHome()
      const found: DiskEntry[] = []

      for (const root of PLUGIN_ROOTS) {
        found.push(...(await restList(home, root)))
      }

      return found
    },
    read: async entry => (await readDesktopFileText(entry.file)).text
  }
}

/**
 * The door in force, or null when there is none (no local root and the REST door
 * switched off — the loader then cleanly does nothing).
 *
 * Local WINS whenever it has plugins: a developer's own machine outranks whatever
 * the backend is carrying. It falls through to REST when the local root is empty
 * or unavailable, which is the only state a phone is ever in.
 */
export async function resolvePluginDisk(): Promise<PluginDisk | null> {
  if (IS_DESKTOP) {
    const local = localDisk()

    try {
      if ((await local.list()).length > 0) {
        return local
      }
    } catch {
      // No root / unreadable — fall through to the REST door.
    }

    if (!$restDoorEnabled.get()) {
      // Still the local door: an empty local root with REST off is "no plugins
      // yet", and the settings page must show the real root to reveal.
      return local
    }
  }

  return $restDoorEnabled.get() ? restDisk() : null
}
