/**
 * Pins the request each new REST helper builds — path, method and body key
 * spelling — against the FastAPI models in hermes_cli/web_models.py, which
 * reject an unknown body rather than ignoring it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({ api: vi.fn() }))

import { api } from '@/lib/api'

import {
  exportProfileArchive,
  getAllProfilesProjectTree,
  getGhAuthStatus,
  getProfileDesktopOverlay,
  importProfileArchive,
  listRepoPullRequests,
  scanSessionPullRequests
} from './gateway-rest'

const rest = vi.mocked(api)

beforeEach(() => {
  rest.mockReset()
  rest.mockResolvedValue({})
})

const sent = () => rest.mock.calls[0]?.[0]

describe('profile portable bundles', () => {
  it('imports an archive by BACKEND path, normalising a blank name to null', async () => {
    await importProfileArchive('/tmp/work.tar.gz', '')

    expect(sent()).toMatchObject({
      path: '/api/profiles/import',
      method: 'POST',
      body: { archive: '/tmp/work.tar.gz', name: null }
    })
  })

  it('returns the bundled appearance overlay so the caller needs no second round-trip', async () => {
    rest.mockResolvedValue({ ok: true, name: 'work', path: '/home/h/.work', desktop: { skin: 'neon' } })

    await expect(importProfileArchive('/tmp/work.tar.gz')).resolves.toMatchObject({
      name: 'work',
      desktop: { skin: 'neon' }
    })
  })

  it('exports with snake_case body keys and an encoded profile name', async () => {
    await exportProfileArchive('my profile', { extraFiles: { 'desktop.json': '{}' } })

    expect(sent()).toMatchObject({
      path: '/api/profiles/my%20profile/export',
      method: 'POST',
      body: { extra_files: { 'desktop.json': '{}' }, output: '' }
    })
  })

  it('defaults export to an empty staging set so the backend names the archive', async () => {
    await exportProfileArchive('work')

    expect(sent()).toMatchObject({ body: { extra_files: {}, output: '' } })
  })

  it('reads an overlay with a plain GET and reports a profile that never carried one', async () => {
    rest.mockResolvedValue({ exists: false, desktop: null })

    await expect(getProfileDesktopOverlay('work')).resolves.toEqual({ exists: false, desktop: null })
    expect(sent()).toEqual({ path: '/api/profiles/work/desktop-overlay' })
  })
})

describe('pull requests', () => {
  it('posts branches and numbers, defaulting numbers to an empty list', async () => {
    rest.mockResolvedValue({ ghReady: true, prs: [] })

    await listRepoPullRequests('/repo', ['main', 'feat/x'])

    expect(sent()).toMatchObject({
      path: '/api/git/review/pr-list',
      method: 'POST',
      body: { branches: ['main', 'feat/x'], numbers: [], path: '/repo' }
    })
  })

  it('reports gh being unavailable as ghReady:false rather than an empty answer', async () => {
    rest.mockResolvedValue({ ghReady: false, prs: [] })

    await expect(listRepoPullRequests('/repo', [], [12])).resolves.toEqual({ ghReady: false, prs: [] })
    expect(sent()).toMatchObject({ body: { branches: [], numbers: [12], path: '/repo' } })
  })

  it('scans sessions by id and returns every id it looked at, not only the hits', async () => {
    rest.mockResolvedValue({ pull_requests: { a: { number: 4, url: 'https://x/pull/4' } }, scanned: ['a', 'b'] })

    await expect(scanSessionPullRequests(['a', 'b'])).resolves.toEqual({
      pull_requests: { a: { number: 4, url: 'https://x/pull/4' } },
      scanned: ['a', 'b']
    })
    expect(sent()).toMatchObject({
      path: '/api/profiles/sessions/pull-requests',
      method: 'POST',
      body: { ids: ['a', 'b'] }
    })
  })
})

// --- The 2026-08-18 / 2026-08-20 sync (MJXHRM-444) -------------------------

describe('GET /api/git/gh-auth', () => {
  it('reads the cached answer by default — the backend shells out to `gh`', async () => {
    await getGhAuthStatus()

    expect(sent()).toEqual({ path: '/api/git/gh-auth' })
  })

  // The backend caches for 5 minutes. Without this the screen keeps reporting
  // the pre-login state for the rest of the window after `gh auth login`.
  it('busts the 5-minute cache when the user has just been sent off to log in', async () => {
    await getGhAuthStatus({ refresh: true })

    expect(sent()).toEqual({ path: '/api/git/gh-auth?refresh=true' })
  })

  it('distinguishes "gh is missing" from "gh is logged out" — both are falsy `authenticated`', async () => {
    rest.mockResolvedValue({ available: false, authenticated: false })

    await expect(getGhAuthStatus()).resolves.toEqual({ available: false, authenticated: false })
  })
})

describe('GET /api/profiles/projects/tree', () => {
  it('sends no query at all when neither limit is pinned, so the backend defaults stand', async () => {
    await getAllProfilesProjectTree()

    expect(sent()).toEqual({ path: '/api/profiles/projects/tree' })
  })

  it('sends only the limits the caller set', async () => {
    await getAllProfilesProjectTree({ previewLimit: 5 })

    expect(sent()).toEqual({ path: '/api/profiles/projects/tree?preview_limit=5' })
  })

  it('sends an explicit 0, which is a real limit and not an absent one', async () => {
    await getAllProfilesProjectTree({ previewLimit: 0, sessionLimit: 10 })

    expect(sent()).toEqual({ path: '/api/profiles/projects/tree?preview_limit=0&session_limit=10' })
  })

  // The route answers 200 with per-profile failures collected in `errors`, so a
  // caller that ignores them reports a PARTIAL tree as the complete one.
  it('surfaces the per-profile failures the 200 response carries', async () => {
    rest.mockResolvedValue({
      projects: [],
      active_id: null,
      scoped_session_ids: [],
      errors: [{ profile: 'x', error: 'locked' }]
    })

    await expect(getAllProfilesProjectTree()).resolves.toMatchObject({ errors: [{ profile: 'x', error: 'locked' }] })
  })
})
