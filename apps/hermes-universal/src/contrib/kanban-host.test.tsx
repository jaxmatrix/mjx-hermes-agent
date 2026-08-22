/**
 * The shared kanban sample AT UNIVERSAL'S HOST BOUNDARY (MJXHRM-461).
 *
 * `packages/hermes-sample-plugins/kanban` is the SDK's only real
 * third-party-shaped consumer, and universal ships it: `contrib/plugins.ts`
 * globs that directory eagerly and registers whatever it finds. Everything the
 * board needs is already here — every area it contributes to is hosted, all 70
 * SDK symbols it imports resolve, `ctx.rest`'s multipart `upload` (MJXHRM-403)
 * exists, and `ctx.os.notify` already lands on `tauri-plugin-notification`.
 *
 * Nothing PROVED it. The sample's own 44 tests are unit tests: they mock
 * `@hermes/plugin-sdk` wholesale (completion-notify.test.ts) or import one
 * component in isolation (model-override.test.tsx), so none of them ever
 * touches universal's real `createPluginContext`, its real registry, or the
 * real Tauri notification door. A dropped SDK export, a renamed area, a
 * `ctx` member that stopped working, or the notification chain coming unhooked
 * would all have been invisible to CI.
 *
 * So this file registers the REAL plugin through the REAL host and renders what
 * comes out. The only things stubbed are the two edges universal cannot have in
 * jsdom: the gateway (`pluginRest`/`pluginSocket`) and the OS
 * (`@tauri-apps/plugin-notification`). Everything between them — the plugin
 * context, the registry, the areas, the board, the drawer, the model-override
 * picker, `completion-notify` — is the shipping code.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PALETTE_AREA } from '@/app/command-palette/contrib'
import { STATUSBAR_AREAS } from '@/app/contrib/surfaces'
import { ROUTES_AREA, SIDEBAR_NAV_AREA } from '@/app/routes'
import type * as Hermes from '@/hermes'
import { I18nProvider } from '@/i18n'
import { KEYBINDS_AREA } from '@/lib/keybinds/actions'

import kanbanPlugin from '../../../../packages/hermes-sample-plugins/kanban/plugin'

import { createPluginContext } from './plugin'
import { registry } from './registry'

// ── the two real edges ───────────────────────────────────────────────────────

const sendNotification = vi.fn()

vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: () => Promise.resolve(true),
  requestPermission: () => Promise.resolve('granted'),
  sendNotification: (...args: unknown[]) => sendNotification(...args)
}))

const restCalls: string[] = []

vi.mock('@/lib/plugin-transport', () => ({ pluginSocket: () => () => {} }))

vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<typeof Hermes>()),
  getGlobalModelOptions: () => Promise.resolve({ providers: [] }),
  pluginRest: (_id: string, path: string) => {
    restCalls.push(path)

    return Promise.resolve(restFixture(path))
  }
}))

// ── fixtures ─────────────────────────────────────────────────────────────────
// Deliberately DISAGREEING with the assertions' defaults: the card is in
// `running` (not the first column), and the task carries a real model override
// (not the "Profile default" the field falls back to), so an assertion can only
// pass by reading this fixture through the component under test.

const TASK = {
  id: 't_a1b2c3',
  title: 'Reap the stale worktrees',
  status: 'running',
  assignee: 'orchestrator',
  body: 'Sweep every worktree whose worker is gone.',
  created_at: 1_700_000_000,
  model_override: 'gemini-3.1-pro',
  provider_override: 'google',
  reasoning_effort: ''
}

const BOARD = {
  assignees: ['orchestrator'],
  columns: [
    { name: 'triage', tasks: [] },
    { name: 'running', tasks: [TASK] }
  ],
  latest_event_id: 100,
  now: 1_700_000_100,
  tenants: []
}

function restFixture(path: string): unknown {
  if (path.startsWith('/tasks/') && path.includes('/log')) {
    return { content: '', exists: false, size_bytes: 0, truncated: false }
  }

  if (path.startsWith('/tasks/')) {
    return { attachments: [], comments: [], events: [], links: { children: [], parents: [] }, runs: [], task: TASK }
  }

  // `/boards` before `/board` — the board fixture has no `boards` array, and
  // the sample dereferences it unguarded (board.tsx NewTaskDialog).
  if (path.startsWith('/boards')) {
    return { boards: [{ name: 'default', slug: '' }], current: '' }
  }

  if (path.startsWith('/board')) {
    return BOARD
  }

  if (path.startsWith('/profiles')) {
    return { profiles: [{ description: '', description_auto: false, is_default: true, name: 'orchestrator' }] }
  }

  if (path.startsWith('/projects')) {
    return { projects: [] }
  }

  if (path.startsWith('/orchestration')) {
    return {
      auto_decompose: false,
      default_assignee: 'orchestrator',
      orchestrator_profile: 'orchestrator',
      resolved_default_assignee: 'orchestrator',
      resolved_orchestrator_profile: 'orchestrator'
    }
  }

  return {}
}

// ── the host boundary ────────────────────────────────────────────────────────

let dispose: (() => void) | null = null

/** Register the sample exactly the way `discoverBundledPlugins()` does. */
function registerKanban() {
  const disposers: (() => void)[] = []
  kanbanPlugin.register(createPluginContext(kanbanPlugin.id, fn => disposers.push(fn)))

  dispose = () => disposers.forEach(fn => fn())
}

/** Pull one contribution back out of the REAL registry by its namespaced id. */
const contribution = (area: string, localId: string) => registry.getArea(area).find(c => c.id === `kanban:${localId}`)

function renderContribution(area: string, localId: string) {
  const node = contribution(area, localId)
  expect(node?.render, `${area}/${localId} has no render`).toBeTypeOf('function')

  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <I18nProvider>{node!.render!()}</I18nProvider>
    </QueryClientProvider>
  )
}

beforeEach(() => {
  restCalls.length = 0
  sendNotification.mockClear()
  registerKanban()
})

afterEach(() => {
  cleanup()
  dispose?.()
  dispose = null
})

describe('the kanban sample registers into universal’s real registry', () => {
  it('lands every contribution in an area universal actually hosts', () => {
    // Each of these areas has a live consumer in this app: routes →
    // app/contrib/panes.tsx WorkspaceRoutes, sidebar.nav → app/chat/sidebar/
    // nav-rail.tsx, statusBar.right → app/contrib/surfaces.tsx, palette →
    // app/command-palette/contrib.ts, keybinds → lib/keybinds/actions.ts.
    // Registering into an area nothing renders is precisely the "loaded but
    // never rendered" failure this ticket was filed about.
    expect(contribution(ROUTES_AREA, 'page')?.data).toEqual({ path: '/kanban' })
    expect(contribution(SIDEBAR_NAV_AREA, 'nav')?.data).toMatchObject({ label: 'Kanban', path: '/kanban' })
    expect(contribution(STATUSBAR_AREAS.right, 'count')).toBeDefined()
    expect(contribution(PALETTE_AREA, 'open')?.data).toMatchObject({ id: 'kanban.open' })
    expect(contribution(KEYBINDS_AREA, 'new-task')?.data).toMatchObject({
      defaults: ['mod+alt+n'],
      id: 'kanban.newTask'
    })
  })

  it('stamps the host’s provenance on what the plugin wrote', () => {
    // The plugin never sets `source` or the id prefix — `createPluginContext`
    // does. If that scoping regressed, two plugins could collide silently.
    expect(contribution(ROUTES_AREA, 'page')?.source).toBe('plugin:kanban')
  })

  it('registers the board at a path contributedRoutes() will actually mount', async () => {
    // `contributedRoutes()` filters on its own rules (one segment, no params,
    // no squatting on a reserved path). A contribution that survives
    // registration but not that filter renders nowhere.
    const { contributedRoutes } = await import('@/app/routes')

    expect(contributedRoutes().map(route => route.path)).toContain('/kanban')
  })
})

describe('the board, the drawer and the model override render through the host', () => {
  it('renders the board page from the routes contribution, with the fixture’s card', async () => {
    renderContribution(ROUTES_AREA, 'page')

    expect(await screen.findByText(TASK.title)).toBeInTheDocument()
    // Proves the render went through ctx.rest (the plugin's namespaced REST
    // door), not some stub inside the sample.
    expect(restCalls.some(path => path.startsWith('/board'))).toBe(true)
  })

  it('opens the task drawer from a card click and shows the model override', async () => {
    renderContribution(ROUTES_AREA, 'page')

    fireEvent.click(await screen.findByText(TASK.title))

    // `provider: model` is a string only `overrideLabel()` composes, and only
    // from this fixture's override fields — the inherit fallback ("Profile
    // default") is what a broken read would show instead.
    expect(await screen.findByText('google: gemini-3.1-pro')).toBeInTheDocument()
    expect(restCalls.some(path => path.startsWith(`/tasks/${TASK.id}`))).toBe(true)
  })

  it('renders the statusbar pill from the live board counts', async () => {
    renderContribution(STATUSBAR_AREAS.right, 'count')

    // One running task in the fixture, none ready — the pill shows the sum and
    // hides itself at zero, so "1" here can only come from the board query.
    expect(await screen.findByText('1')).toBeInTheDocument()
  })
})

describe('completion-notify reaches the Tauri notification plugin', () => {
  it('turns a terminal kanban event into an OS notification via ctx.os', async () => {
    // The whole chain, unmocked except its two ends: the sample's
    // `onKanbanEventsFrame` → `ctx.os.notify` (contrib/plugin.ts) →
    // `dispatchPluginNativeNotification` (store/native-notifications.ts) →
    // `sendNotification` (@tauri-apps/plugin-notification).
    const { onKanbanEventsFrame } = await import('../../../../packages/hermes-sample-plugins/kanban/completion-notify')

    // The native door fires only while the user is AWAY from Hermes — that is
    // the entire point of it next to the in-app toast.
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)

    // id 101 > the fixture's latest_event_id (100), so it is new, not replay.
    const fired = await onKanbanEventsFrame('demo', [
      { id: 101, kind: 'completed', payload: { summary: 'Worktrees reaped' }, task_id: TASK.id }
    ])

    expect(fired).toBe(true)
    await waitFor(() => expect(sendNotification).toHaveBeenCalledTimes(1))
    expect(sendNotification.mock.calls[0][0]).toMatchObject({ title: 'Task completed' })
    expect(String(sendNotification.mock.calls[0][0].body)).toContain('Worktrees reaped')
  })

  it('stays silent for a non-terminal event on the same socket', async () => {
    const { onKanbanEventsFrame } = await import('../../../../packages/hermes-sample-plugins/kanban/completion-notify')

    vi.spyOn(document, 'hasFocus').mockReturnValue(false)

    // `status` advances the cursor and notifies nothing — a board that pinged
    // the OS on every status change would be unusable.
    const fired = await onKanbanEventsFrame('quiet', [{ id: 51, kind: 'status', payload: {}, task_id: TASK.id }])

    expect(fired).toBe(false)
    expect(sendNotification).not.toHaveBeenCalled()
  })
})
