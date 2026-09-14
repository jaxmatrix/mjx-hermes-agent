import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { registry } from '@/contrib/registry'
import { getEnvVars, getHermesConfigSchema } from '@/hermes'
import { queryClient } from '@/lib/query-client'
import { $commandPaletteOpen, closeCommandPalette, openCommandPalettePage } from '@/store/command-palette'
import { $findInPage, closeFindBar } from '@/store/find-in-page'
import { $settingsScopeOverride } from '@/store/settings-scope'
import type * as WindowsStore from '@/store/windows'
import { openAppRoute } from '@/store/windows'
import { $mode, $skin, $themePreview, ThemeProvider } from '@/themes/context'

import { PALETTE_AREA, paletteToggle } from './contrib'

import { CommandPalette } from './index'

// The palette lazily fetches sessions + config while open; neither is the
// subject here, and both would otherwise hit the gateway.
vi.mock('@/hermes', () => ({
  setApiRequestProfile: vi.fn(),
  getHermesConfigRecord: vi.fn(async () => ({ tts: { provider: 'openai' } })),
  // The settings catalog reads both under the current "Applies to" scope.
  getHermesConfigSchema: vi.fn(async () => ({ fields: { 'agent.max_turns': { type: 'number' } } })),
  getEnvVars: vi.fn(async () => ({
    TAVILY_API_KEY: {
      advanced: false,
      category: 'tool',
      description: 'Tavily search',
      is_password: true,
      is_set: false,
      redacted_value: null,
      tools: [],
      url: null
    }
  })),
  getProfiles: vi.fn(async () => ({ profiles: [] })),
  listAllProfileSessions: vi.fn(async () => ({ sessions: [], total: 0, offset: 0 }))
}))

// Navigation is the seam every row goes through — assert on it rather than on a
// router the palette deliberately doesn't use.
vi.mock('@/store/windows', async importOriginal => ({
  ...(await importOriginal<typeof WindowsStore>()),
  openAppRoute: vi.fn()
}))

// ThemeProvider is not decoration here: `useTheme()`'s default context has
// no-op setters, so a palette rendered outside it can neither preview nor apply
// a theme and the theme rows would assert nothing.
const renderPalette = () =>
  render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <CommandPalette />
      </ThemeProvider>
    </QueryClientProvider>
  )

const openPalette = () => {
  $commandPaletteOpen.set(true)

  return renderPalette()
}

// Queried by role, not placeholder: a nested page swaps the placeholder for
// its own copy.
const input = () => screen.getByRole('combobox')

// A matching row's label is split across <mark>s, so getByText can't see it as
// one string — match on the row instead.
const rowLabels = () => screen.getAllByRole('option').map(row => row.textContent)

afterEach(() => {
  cleanup()
  $commandPaletteOpen.set(false)
  queryClient.clear()
  vi.clearAllMocks()
})

describe('CommandPalette', () => {
  it('lists the app destinations under Go to and filters by query', () => {
    openPalette()

    expect(screen.getByText('Go to')).toBeInTheDocument()
    expect(screen.getByText('Agents')).toBeInTheDocument()
    expect(screen.getByText('Starmap')).toBeInTheDocument()

    fireEvent.change(input(), { target: { value: 'star' } })

    expect(rowLabels()).toContain('Starmap')
    expect(rowLabels()).not.toContain('Agents')
  })

  it('emphasizes the matched letters so a row says why it is in the list', () => {
    openPalette()
    fireEvent.change(input(), { target: { value: 'star' } })

    const marks = screen.getAllByRole('option')[0].querySelectorAll('mark')

    expect([...marks].map(mark => mark.textContent)).toEqual(['Star'])
  })

  it('ranks the best label match first so the auto-highlight lands on it', () => {
    openPalette()
    fireEvent.change(input(), { target: { value: 'settings' } })

    // cmdk selects the first rendered item on every query change, so "first"
    // is what the ranking has to get right.
    const rows = screen.getAllByRole('option')
    expect(rows[0].textContent).toContain('Settings')
  })

  it('navigates through openAppRoute and closes', () => {
    openPalette()
    fireEvent.click(screen.getByText('Starmap'))

    expect(openAppRoute).toHaveBeenCalledWith('/starmap')
    expect($commandPaletteOpen.get()).toBe(false)
  })

  // ⌘F is not an affordance on a phone, and the palette lists a curated set of
  // rows rather than the keybind registry — so without this row find-in-page
  // could not be opened at all on a touch device (MJXHRM-387).
  it('opens find-in-page, the one surface that had no non-keyboard door', () => {
    Object.defineProperty(window, 'find', { configurable: true, value: () => true, writable: true })

    openPalette()
    fireEvent.click(screen.getByText('Find in page'))

    expect($findInPage.get().active).toBe(true)
    expect($commandPaletteOpen.get()).toBe(false)

    closeFindBar()
  })

  it('opens a nested page via `to` and steps back out on empty Backspace', () => {
    openPalette()
    fireEvent.click(screen.getByText('Change theme'))

    // The back header names the page, and the root groups are gone.
    expect(screen.getByText('Back')).toBeInTheDocument()
    expect(screen.queryByText('Go to')).not.toBeInTheDocument()
    expect($commandPaletteOpen.get()).toBe(true)

    fireEvent.keyDown(input(), { key: 'Backspace' })

    expect(screen.getByText('Go to')).toBeInTheDocument()
  })

  it('keeps the palette open for a live-preview row', () => {
    openPalette()
    fireEvent.change(input(), { target: { value: 'dark' } })
    fireEvent.click(screen.getAllByText('Dark')[0])

    // Theme/mode rows preview in place — closing would hide the result.
    expect($commandPaletteOpen.get()).toBe(true)
  })

  it('shows a no-results message rather than an empty surface', () => {
    openPalette()
    fireEvent.change(input(), { target: { value: 'zzzznothing' } })

    expect(screen.getByText('No matching results found.')).toBeInTheDocument()
  })
})

describe('palette contributions', () => {
  const register = (data: unknown, id = 'demo:cmd') =>
    registry.register({ area: PALETTE_AREA, data, id, source: 'plugin:demo' })

  it('groups plugin commands apart from the app destinations and runs one on click', () => {
    const run = vi.fn()
    const dispose = register({ id: 'demo:cmd', label: 'Rebuild index', run })

    openPalette()

    // Its own group, so a plugin row never masquerades as a built-in destination.
    expect(screen.getByText('Commands')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Rebuild index'))

    expect(run).toHaveBeenCalledOnce()
    expect($commandPaletteOpen.get()).toBe(false)

    dispose()
  })

  it('omits the Commands group when nothing contributes', () => {
    openPalette()

    expect(screen.queryByText('Commands')).not.toBeInTheDocument()
  })

  it('matches a contributed command on its keywords, not just its label', () => {
    const dispose = register({ id: 'demo:cmd', keywords: ['reindex', 'cache'], label: 'Rebuild index', run: vi.fn() })

    openPalette()
    fireEvent.change(input(), { target: { value: 'reindex' } })

    // Matched on a keyword, so the label carries no <mark> — getByText is safe.
    expect(screen.getByText('Rebuild index')).toBeInTheDocument()
    expect(rowLabels()).not.toContain('Agents')

    dispose()
  })

  it('runs the highlighted match on Enter', () => {
    const run = vi.fn()
    const dispose = register({ id: 'demo:cmd', label: 'Zebra command', run })

    openPalette()
    fireEvent.change(input(), { target: { value: 'zebra' } })
    fireEvent.keyDown(input(), { key: 'Enter' })

    expect(run).toHaveBeenCalledOnce()

    dispose()
  })

  it('shows a toggle row its live state and leaves the palette open to flip again', () => {
    let on = false

    const dispose = register(
      paletteToggle({ get: () => on, id: 'demo:flag', label: 'Toggle demo flag', set: next => (on = next) }).data,
      'demo:flag'
    )

    openPalette()

    const row = () => screen.getAllByRole('option').find(option => option.textContent?.startsWith('Toggle demo flag'))

    expect(row()?.textContent).toBe('Toggle demo flagoff')

    fireEvent.click(screen.getByText('Toggle demo flag'))

    // Flipping is the kind of thing you do twice — the palette stays, and the
    // note re-reads rather than reporting where the setting used to stand.
    expect($commandPaletteOpen.get()).toBe(true)
    expect(on).toBe(true)
    expect(row()?.textContent).toBe('Toggle demo flagon')

    dispose()
  })

  it('drops a malformed contribution instead of rendering a dead row', () => {
    const disposers = [
      register({ id: 'demo:no-run', label: 'No run' }, 'demo:no-run'),
      register({ id: 'demo:no-label', run: vi.fn() }, 'demo:no-label')
    ]

    openPalette()

    expect(screen.queryByText('No run')).not.toBeInTheDocument()
    // The core rows are untouched.
    expect(screen.getByText('Agents')).toBeInTheDocument()

    for (const dispose of disposers) {
      dispose()
    }
  })

  it('survives a throwing command — the palette still closes', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const dispose = register({
      id: 'demo:cmd',
      label: 'Boom',
      run: () => {
        throw new Error('plugin exploded')
      }
    })

    openPalette()

    expect(() => fireEvent.click(screen.getByText('Boom'))).not.toThrow()
    expect($commandPaletteOpen.get()).toBe(false)

    spy.mockRestore()
    dispose()
  })
})

// ── Settings search (MJXHRM-449 / MJXHRM-489) ───────────────────────────────
// Deep results: a config field, a credential and a device-local pref all have to
// be reachable by typing their own name, and each has to land on its own row.
describe('settings search in the palette', () => {
  afterEach(() => $settingsScopeOverride.set(null))

  // The match is split across <mark>s, so the row is found by its own
  // textContent rather than by getByText (see rowLabels above).
  const rowFor = async (query: string, label: string) => {
    openPalette()
    fireEvent.change(input(), { target: { value: query } })

    return waitFor(() => {
      const row = screen.getAllByRole('option').find(option => option.textContent === label)

      expect(row, `no row labelled "${label}" — saw ${JSON.stringify(rowLabels())}`).toBeDefined()

      return row as HTMLElement
    })
  }

  it('finds a schema config field and deep-links to its row', async () => {
    fireEvent.click(await rowFor('max turns', 'Advanced: Max Agent Steps'))

    expect(openAppRoute).toHaveBeenCalledWith('/settings/advanced?field=agent.max_turns')
  })

  it('finds a credential and deep-links to its card on the right sub-tab', async () => {
    fireEvent.click(await rowFor('tavily', 'Tools: TAVILY'))

    expect(openAppRoute).toHaveBeenCalledWith('/settings/keys?key=TAVILY_API_KEY')
  })

  // The row MJXHRM-489 filed: no config key, so nothing schema-driven can reach it.
  it('finds a device-local pref row that has no config key at all', async () => {
    fireEvent.click(await rowFor('intro splash', 'Appearance: Intro Splash'))

    expect(openAppRoute).toHaveBeenCalledWith('/settings/appearance?setting=appearance.intro-splash')
  })

  it('reads the catalog under the settings scope, not the active profile', async () => {
    // Seeded AWAY from the default: a catalog that ignores the scope would call
    // with null and still render the same rows, so assert on the call itself.
    $settingsScopeOverride.set('research')

    await rowFor('max turns', 'Advanced: Max Agent Steps')

    expect(getHermesConfigSchema).toHaveBeenCalledWith('research')
    expect(getEnvVars).toHaveBeenCalledWith('research')
  })
})

// ── Live theme preview (08-20 palette surface) ──────────────────────────────
// Browsing themes has to PAINT them without adopting them, and has to put the
// committed one back the moment you leave.
describe('theme preview from the palette highlight', () => {
  afterEach(() => {
    $themePreview.set(null)
    $skin.set('nous')
    $mode.set('system')
  })

  // Opened the way the app opens it — render closed, then call the real door.
  // Seeding `$commandPaletteOpen` before mount instead would let the body mount
  // once at openCount 0, consume the pending page, and be remounted at 1 with
  // the page state gone.
  const openThemePage = () => {
    renderPalette()
    act(() => openCommandPalettePage('theme'))
  }

  it('paints the highlighted theme without writing the persisted skin', () => {
    // Seeded on a DIFFERENT theme than the one highlighted, so a preview that
    // silently echoed the committed skin would fail here.
    $skin.set('nous')
    $themePreview.set(null)

    openThemePage()
    fireEvent.change(input(), { target: { value: 'cyberpunk' } })

    expect($themePreview.get()?.name).toBe('cyberpunk')
    expect($skin.get()).toBe('nous')
  })

  // Deliberately all on the ROOT list, with no page change: leaving a page
  // clears the preview too, and a test that stepped back out would pass on that
  // clear instead of on the one under test.
  it('clears the preview when the highlight moves to a row that has none', () => {
    openPalette()

    fireEvent.change(input(), { target: { value: 'cyberpunk' } })
    expect($themePreview.get()?.name).toBe('cyberpunk')

    // A plain navigation row — no preview of its own.
    fireEvent.change(input(), { target: { value: 'starmap' } })

    expect($themePreview.get()).toBeNull()
  })

  it('clears the preview at close START, not at unmount', () => {
    openThemePage()
    fireEvent.change(input(), { target: { value: 'cyberpunk' } })
    expect($themePreview.get()?.name).toBe('cyberpunk')

    // The body outlives `open` by the whole exit animation, which never runs in
    // jsdom — so a clear hung off unmount would still be pending right here.
    act(() => closeCommandPalette())

    expect($themePreview.get()).toBeNull()
    expect($skin.get()).toBe('nous')
  })

  it('lists each theme once, with brightness as its own control in the same page', async () => {
    openThemePage()

    // The row list arrives in a deferred follow-up render (opening ⌘K must not
    // wait on building it), so the first commit is deliberately empty.
    await waitFor(() => expect(rowLabels()).toContain('Cyberpunk'))

    const labels = rowLabels()

    // One list, not a Light copy and a Dark copy.
    expect(labels.filter(label => label === 'Cyberpunk')).toHaveLength(1)
    // …and the mode toggle lives here rather than on a separate page.
    expect(labels).toContain('Light')
    expect(labels).toContain('Dark')
    expect(labels).toContain('System')
  })
})
