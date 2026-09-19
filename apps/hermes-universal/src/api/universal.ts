/**
 * The API surface universal has and desktop does not.
 *
 * `src/hermes.ts` is desktop's compatibility barrel over `./api/*`, kept line
 * for line with `apps/desktop/src/hermes.ts` apart from an appended
 * `export * from './api/universal'` and its own `HermesGateway`. Everything
 * else universal needs beyond desktop's surface lives here, so a resync of the
 * barrel stays a two-hunk merge.
 *
 * Only four things qualify. Universal's old monolith exported 19 symbols
 * desktop's `api/*` did not, but 15 of those were duplicates under another
 * name — the filesystem and git helpers are `src/lib/desktop-fs.ts` /
 * `desktop-git.ts`, the skill and toolset toggles are `setSkillEnabled` /
 * `setToolsetEnabled`, and MCP OAuth moved off REST onto gateway JSON-RPC
 * (`mcpOAuthRpc` in `./mcp`). Those were deleted, not moved here.
 *
 * Requests go through desktop's `hermesApi`, not universal's `api()` directly,
 * so there is a single transport path: `hermesApi` -> `window.hermesDesktop.api`
 * -> the bridge in `src/lib/hermes-desktop/` -> `src/lib/api.ts` -> the Rust
 * `http_request` command.
 */

import type { PaginatedSessions, SessionInfo } from '@/types/hermes'

import { hermesApi, profileScoped } from './client'
import type { SessionSourceFilter } from './sessions'

/**
 * Desktop and universal disagree about what an explicit `null` profile means.
 * Desktop's `profileScoped` treats `null` as "clear the scope" and only
 * `undefined` as "use the ambient profile"; universal's old monolith treated
 * both as ambient (`override ?? _apiProfile ?? ''`). Universal's callers pass
 * `profile?: null | string` freely and mean ambient by it, so normalise here
 * rather than change 200 call sites — and rather than silently send a
 * different profile on the wire, which no type error would catch.
 */
const ambient = (profile?: null | string): string | undefined => profile ?? undefined

// ── Project-local skills ────────────────────────────────────────────────────
//
// The project skill tier has no desktop counterpart: `/api/skills/project*`
// appears nowhere under desktop's `api/`.

export interface ProjectSkillsStatus {
  /** Every SKILL.md the project tier holds, quarantined ones included. */
  skills: { name: string; path: string; quarantined: boolean }[]
  /** False when `skills.project_discovery` is off for this profile. */
  discovery_enabled: boolean
  /** The enclosing git root, or null when the cwd is not inside a checkout. */
  root: null | string
  trusted: boolean
}

/** What the project-local skill tier holds for `cwd`, and whether that repo is
 *  trusted. Skills vendored in a repo do not load until the user says so — this
 *  is the read half of that gate (the CLI half is `hermes skills trust`). */
export function getProjectSkills(cwd?: null | string, profile?: null | string): Promise<ProjectSkillsStatus> {
  const dir = (cwd ?? '').trim()

  return hermesApi<ProjectSkillsStatus>({
    ...profileScoped(ambient(profile)),
    path: `/api/skills/project${dir ? `?cwd=${encodeURIComponent(dir)}` : ''}`
  })
}

/** Trust (or stop trusting) a repo's project-local skills. `path` must be the
 *  `root` a `getProjectSkills` call resolved — trust is stored by resolved path,
 *  so trusting a subdirectory would silently load nothing. */
export function setProjectSkillsTrust(
  path: string,
  trusted: boolean,
  profile?: null | string
): Promise<{ ok: boolean; root: string; trusted: boolean }> {
  return hermesApi<{ ok: boolean; root: string; trusted: boolean }>({
    ...profileScoped(ambient(profile)),
    path: '/api/skills/project/trust',
    method: 'PUT',
    body: { path, trusted, ...profileScoped(ambient(profile)) }
  })
}

// ── Workspace file search ───────────────────────────────────────────────────

/** Shape-identical to desktop's `HermesReadDirEntry`, plus the match rank.
 *  Kept local because the search route itself is universal-only. */
export interface FsSearchEntry {
  name: string
  path: string
  isDirectory: boolean
  rank: number
}

export interface FsSearchResult {
  entries: FsSearchEntry[]
  error?: string
}

/**
 * `GET /api/fs/search`.
 *
 * ADDITIVE ROUTE: a gateway that predates it 404s here, so callers MUST
 * feature-detect, and MUST do it on the body rather than the status — this
 * route answers 200 with `entries` for everything it can be asked, a missing
 * directory included. `store/file-search.ts` owns that degradation; nothing
 * else should call this directly.
 */
export function searchDir(path: string, q: string, limit: number): Promise<FsSearchResult> {
  return hermesApi<FsSearchResult>({
    ...profileScoped(),
    path: `/api/fs/search?path=${encodeURIComponent(path)}&q=${encodeURIComponent(q)}&limit=${encodeURIComponent(String(limit))}`
  })
}

// ── Paged cross-profile session listing ─────────────────────────────────────

/**
 * Copied from `./sessions`, where it is module-private and cannot be exported
 * without making that byte-identical desktop file a merge target.
 *
 * Trim a page to its window WITHOUT discarding pinned rows. The list endpoints
 * deliberately back-fill pinned conversations past their LIMIT — a pin means
 * "always reachable" — so a plain `slice(0, limit)` throws exactly those rows
 * away again, which is why pins silently stopped rendering past some count.
 */
function pageWindow(sessions: SessionInfo[], limit: number): SessionInfo[] {
  if (sessions.length <= limit) {
    return sessions
  }

  const recent = sessions.slice(0, limit)

  return [...recent, ...sessions.slice(limit).filter(session => session.pinned)]
}

/** Same value as `./sessions`' module-private constant, for the same reason. */
const SESSION_LIST_REQUEST_TIMEOUT_MS = 60_000

/** How deep `/api/profiles/sessions` can page. The backend over-fetches
 *  `limit + offset` rows PER PROFILE to merge a correct window and clamps that
 *  at 500, so `offset + limit` beyond this silently returns a short page. */
export const PROFILE_SESSIONS_WINDOW_CAP = 500

/**
 * `listAllProfileSessions` with an offset.
 *
 * Desktop's version in `./sessions` hardcodes `offset=0`, because desktop pages
 * this list a different way. Universal's sidebar scrolls it, so dropping the
 * offset would leave infinite scroll re-fetching page 1 forever — silently, and
 * with no type error once the extra argument is removed to make it compile.
 *
 * Deliberately a distinct NAME rather than an override: two `export *` barrels
 * exporting the same symbol resolve to neither, so shadowing desktop's export
 * would break the barrel outright.
 */
export async function listProfileSessionsPage(
  limit = 40,
  minMessages = 0,
  archived: 'exclude' | 'include' | 'only' = 'exclude',
  order: 'created' | 'recent' = 'recent',
  profile: 'all' | (string & {}) = 'all',
  filter: SessionSourceFilter = {},
  offset = 0
): Promise<PaginatedSessions> {
  const sourceParam = filter.source ? `&source=${encodeURIComponent(filter.source)}` : ''

  const excludeParam = filter.excludeSources?.length
    ? `&exclude_sources=${encodeURIComponent(filter.excludeSources.join(','))}`
    : ''

  // The aggregator over-fetches `limit + offset` per profile to build a correct
  // merged window, and caps that at 500 (`hermes_cli/web_server.py`
  // `get_profiles_sessions`). Past the cap it silently returns a short page, so
  // stop asking for a window it cannot serve.
  const from = Math.min(Math.max(0, offset), Math.max(0, PROFILE_SESSIONS_WINDOW_CAP - limit))

  const result = await hermesApi<PaginatedSessions>({
    path:
      `/api/profiles/sessions?limit=${limit}&offset=${from}&min_messages=${Math.max(0, minMessages)}` +
      `&archived=${archived}&order=${order}&profile=${encodeURIComponent(profile)}${sourceParam}${excludeParam}`,
    timeoutMs: SESSION_LIST_REQUEST_TIMEOUT_MS
  })

  return {
    ...result,
    sessions: pageWindow(result.sessions, limit),
    offset: from
  }
}

// ── The plugin namespace boundary (MJXHRM-403) ──────────────────────────────
//
// Kept because desktop's is weaker, not because universal's is different for
// its own sake. `api/plugins.ts:59` rejects traversal with a STRING test —
// `suffix.split('/').includes('..')` — and that is precisely the check
// MJXHRM-403 showed to be insufficient: WHATWG URL parsing (what both the
// webview and Rust's `url` crate implement) also treats `%2e%2e`, `%2E%2E`,
// `.%2e` and `%2e.` as double-dot segments AND `\` as a separator, so
// `/%2e%2e/%2e%2e/api/fs/read` and `/..\..\api/fs/read` leave the namespace
// while containing no literal `..` segment. What came out the other side was an
// authenticated POST to a core route with the app's session credentials.
//
// `src/lib/plugin-transport.ts` (universal's Tauri-socket plugin door) resolves
// its paths through this. Desktop's `pluginRest`/`pluginSocket` still use the
// string test — flagged for the owner, not silently patched here, because
// api/plugins.ts is byte-identical to desktop and fixing it belongs upstream.

/** A plugin id may be ONE ordinary path segment. It is interpolated straight
 *  into `/api/plugins/<id>`, so an id carrying a separator or a dot-segment
 *  would relocate the namespace itself — and it is equally the `plugin:<id>`
 *  source tag, the `hermes.plugin.<id>.*` storage prefix and the contribution
 *  id prefix, none of which survive a `/` either. */
const PLUGIN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** The only base a plugin path is ever resolved against here. Opaque host: it
 *  exists so `new URL` will resolve, and nothing reads it back. */
const PLUGIN_PATH_BASE = 'http://plugin.invalid'

/**
 * The plugin namespace path — `/api/plugins/<id>` plus a caller-supplied
 * relative `path`, and the ONE place that boundary is computed.
 *
 * The check is containment after URL resolution, not a substring test for
 * `..`, because the two do not agree. WHATWG (which is what both the webview
 * and Rust's `url` crate implement) also treats `%2e%2e`, `%2E%2E`, `.%2e`,
 * `%2e.` as double-dot segments AND `\` as a path separator — so
 * `/%2e%2e/%2e%2e/api/fs/read` and `/..\..\api/fs/read` each leave the
 * namespace while containing no literal `..` path segment at all. A string
 * test passed both; `POST`ing to a core route with the app's session
 * credentials attached is what came out the other side, and MJXHRM-403's new
 * `upload` extended that to an authenticated multipart POST anywhere on the
 * gateway.
 *
 * Resolving here is exact rather than approximate: the string returned is
 * parsed downstream with the same rules, so what this function accepts is
 * literally what goes on the wire.
 *
 * Only the path portion is a boundary — `..` inside a query or fragment is
 * the caller's data and passes through untouched.
 */
export function pluginNamespacePath(caller: string, pluginId: string, path: string): string {
  if (!PLUGIN_ID_RE.test(pluginId)) {
    throw new Error(`${caller}: illegal plugin id "${pluginId}"`)
  }

  const base = `/api/plugins/${pluginId}`
  const full = `${base}${path.startsWith('/') ? path : `/${path}`}`
  let resolved: URL

  try {
    resolved = new URL(full, PLUGIN_PATH_BASE)
  } catch {
    throw new Error(`${caller}: unresolvable path "${path}"`)
  }

  if (resolved.pathname !== base && !resolved.pathname.startsWith(`${base}/`)) {
    throw new Error(`${caller}: illegal path traversal in "${path}"`)
  }

  return full
}
