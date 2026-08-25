/**
 * Typed clients for the REST routes that arrived with the 2026-08-09 backend
 * sync (MJXHRM-230) — the profile portable-bundle trio and the two
 * pull-request resolvers.
 *
 * Same reason as lib/gateway-rpc.ts: the wiring is written once so the feature
 * tickets (SE-N profile backup/restore, SE-L pull requests) consume a call
 * instead of each re-deriving a body shape. Every helper goes through
 * `lib/api.ts`, so it runs over the Rust http_request command with the session
 * token and `?profile=` already attached.
 *
 * Transport only: no atoms, no UI.
 */

import { api } from '@/lib/api'

// Profile archive work is filesystem + tar on the backend, which on a large
// profile is well past the default request budget.
const ARCHIVE_TIMEOUT_MS = 60_000

// --- profile portable bundles ----------------------------------------------

/**
 * The desktop appearance/interface overlay a profile archive can carry
 * (`desktop.json` at the profile root). Deliberately loose: it is authored by
 * whichever app exported the bundle, so every field is optional and unknown
 * ones must survive a round-trip.
 */
export interface ProfileDesktopOverlay {
  /** Layout tree (hermes.desktop.layoutTree.v2 shape). */
  layoutTree?: unknown
  /** Active layout preset id. */
  layoutPreset?: string
  /** Light/dark/system preference. */
  mode?: string
  /** Rail color override for this profile. */
  profileColor?: null | string
  /** Skin name (built-in or bundled user theme). */
  skin?: string
  /** Full user-theme definitions the skin may reference. */
  themes?: Record<string, unknown>
  /** Overlay schema version (1). */
  version?: number
}

export interface ProfileImportResult {
  /** The bundled appearance overlay, when the archive carried one — returned
   *  here so the caller can apply theme/layout without a second round-trip. */
  desktop: null | ProfileDesktopOverlay
  name: string
  ok: boolean
  path: string
}

/** Import a profile `.tar.gz` as a new profile. `archive` is a path on the
 *  BACKEND's filesystem, not an upload. */
export function importProfileArchive(archive: string, name?: null | string): Promise<ProfileImportResult> {
  return api<ProfileImportResult>({
    path: '/api/profiles/import',
    method: 'POST',
    body: { archive, name: name || null },
    timeoutMs: ARCHIVE_TIMEOUT_MS
  })
}

export interface ProfileExportResult {
  /** Absolute path of the written archive on the backend. */
  archive: string
  ok: boolean
}

/**
 * Export a profile to a shareable `.tar.gz` on the backend's filesystem.
 *
 * `extraFiles` stages extra root-level files into the archive alongside the
 * profile's own artifacts — that is how the appearance overlay travels
 * (`{ 'desktop.json': JSON.stringify(overlay) }`). A blank `output` lets the
 * backend name the file under `HERMES_HOME/profile-exports`.
 */
export function exportProfileArchive(
  name: string,
  opts: { extraFiles?: Record<string, string>; output?: string } = {}
): Promise<ProfileExportResult> {
  return api<ProfileExportResult>({
    path: `/api/profiles/${encodeURIComponent(name)}/export`,
    method: 'POST',
    body: { extra_files: opts.extraFiles ?? {}, output: opts.output ?? '' },
    timeoutMs: ARCHIVE_TIMEOUT_MS
  })
}

export interface ProfileDesktopOverlayResult {
  desktop: null | ProfileDesktopOverlay
  exists: boolean
}

/** Read the appearance overlay bundled with an already-imported profile.
 *  `exists: false` is the normal answer for a profile that never carried one. */
export function getProfileDesktopOverlay(name: string): Promise<ProfileDesktopOverlayResult> {
  return api<ProfileDesktopOverlayResult>({
    path: `/api/profiles/${encodeURIComponent(name)}/desktop-overlay`
  })
}

// --- pull requests ---------------------------------------------------------

export interface BranchPullRequest {
  branch: string
  draft: boolean
  number: number
  /** Lowercased by the backend (`open` / `closed` / `merged`). */
  state: string
  title: string
  url: string
}

export interface RepoPullRequests {
  /** False whenever `gh` is missing, unauthenticated, or the query failed — in
   *  which case `prs` is empty and means "unknown", not "none". */
  ghReady: boolean
  prs: BranchPullRequest[]
}

/** Resolve the pull requests for a repo's branches (and/or explicit numbers)
 *  through `gh`. Both lists are deduped and capped backend-side; passing
 *  neither answers `{ ghReady: false, prs: [] }`. */
export function listRepoPullRequests(
  repoPath: string,
  branches: string[],
  numbers?: number[]
): Promise<RepoPullRequests> {
  return api<RepoPullRequests>({
    path: '/api/git/review/pr-list',
    method: 'POST',
    body: { branches, numbers: numbers ?? [], path: repoPath }
  })
}

export interface SessionPullRequestScan {
  /** Keyed by session id; only sessions where a PR was found appear. */
  pull_requests: Record<string, { number: number; url: string }>
  /** Every id that was looked at — so a caller can remember a miss and never
   *  ask again, rather than re-scanning every profile's state.db each refresh. */
  scanned: string[]
}

/** Recover the PR each of these sessions opened from its own transcript — for
 *  sessions whose recorded branch can't answer (they started on trunk and did
 *  the work in a worktree). Read-only; ids are deduped and capped at 2000. */
export function scanSessionPullRequests(ids: string[]): Promise<SessionPullRequestScan> {
  return api<SessionPullRequestScan>({
    path: '/api/profiles/sessions/pull-requests',
    method: 'POST',
    body: { ids }
  })
}

// ===========================================================================
// The 2026-08-18 / 2026-08-20 backend sync (MJXHRM-444)
// ===========================================================================

// --- GET /api/git/gh-auth --------------------------------------------------

export interface GhAuthStatus {
  /** The `gh` binary is on the BACKEND's PATH. False means the whole
   *  pull-request surface is unavailable, not that the user is logged out. */
  available: boolean
  /** `gh auth status` exited 0. Only meaningful when `available`. */
  authenticated: boolean
}

/**
 * Whether the backend's GitHub CLI is installed and logged in.
 *
 * This is what separates "no pull requests" from "cannot see pull requests":
 * `listRepoPullRequests` answers `{ghReady: false, prs: []}` for a missing or
 * unauthenticated `gh`, and a UI that renders that as "none" is lying. Ask this
 * to say WHICH it is.
 *
 * The backend caches the answer for 5 minutes because it shells out; pass
 * `refresh` after the user has been sent off to run `gh auth login`, or the
 * screen keeps reporting the pre-login state for the rest of the window.
 */
export function getGhAuthStatus(options: { refresh?: boolean } = {}): Promise<GhAuthStatus> {
  return api<GhAuthStatus>({
    path: `/api/git/gh-auth${options.refresh ? '?refresh=true' : ''}`
  })
}

// --- GET /api/profiles/projects/tree ---------------------------------------

export interface AllProfilesProjectTree {
  /** Merged across every profile, newest `lastActive` first. Same row shape the
   *  per-profile `projects.tree` RPC returns. */
  projects: unknown[]
  /** Always `null` here — "active project" is a per-profile idea and this view
   *  spans profiles. Do NOT paint a selection from it. */
  active_id: null
  scoped_session_ids: string[]
  /** Per-profile read failures, collected rather than raised: this route answers
   *  200 even when a profile's state.db could not be opened. A caller that
   *  ignores this reports a partial tree as the complete one. */
  errors: { profile: string; error: string }[]
}

/**
 * The project tree across ALL profiles at once.
 *
 * The REST twin of the `projects.tree` RPC, which is scoped to one profile.
 * Use this only for a genuinely cross-profile view; for the sidebar of the
 * profile the app is operating as, `projects.tree` is the cheaper and correct
 * call (this one opens every profile's state.db).
 */
export function getAllProfilesProjectTree(
  options: { previewLimit?: number; sessionLimit?: number } = {}
): Promise<AllProfilesProjectTree> {
  const query = new URLSearchParams()

  if (options.previewLimit !== undefined) {
    query.set('preview_limit', String(options.previewLimit))
  }

  if (options.sessionLimit !== undefined) {
    query.set('session_limit', String(options.sessionLimit))
  }

  const suffix = query.size ? `?${query.toString()}` : ''

  return api<AllProfilesProjectTree>({ path: `/api/profiles/projects/tree${suffix}` })
}

// --- GET /api/files/stream and GET /api/fs/download: deliberately absent ----
//
// Both routes answer with BYTES (Starlette `FileResponse`), and this module
// cannot express that: `lib/api.ts` runs over the Rust `http_request` command,
// whose `HttpResponse.body` is a fully-materialized `string` and is
// `JSON.parse`d on return. A "helper" here would hand a caller a parse error.
//
// Universal's byte path is the `hermes-media://` custom URI scheme
// (src-tauri/src/media.rs), fetched natively by the <video>/<audio> element
// outside the webview, which already proxies to the gateway with a Range header
// bounded to 2 MiB per request and the session token in a header. Reach it
// through `lib/media-stream.ts` `mediaStreamUrl(path)`, not through here.
//
// `/api/files/stream` adds nothing over the `/api/files/download` that seam
// already targets — its inline disposition, nosniff header and 415 media gate
// are all things media.rs re-derives when it builds its own response, and its
// extension allowlist is the same one `streamable_mime()` enforces. Repointing
// a working seam at it would be churn.
//
// `/api/fs/download` is the uncapped arbitrary-path twin, and it is NOT in the
// backend's `_QUERY_TOKEN_API_PATHS` allowlist, so a bare URL cannot carry auth
// and would 401 from any element. Using it at all needs a new Rust command; no
// Loop 2/3 ticket asks to save an arbitrary large file to disk, and the
// read-into-the-webview case is already served by `/api/fs/read-data-url`
// through the capped seam MJXHRM-482 added. Build the command when a consumer
// exists — not before.
