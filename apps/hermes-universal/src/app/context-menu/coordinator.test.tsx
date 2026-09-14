/**
 * The coordinator's behaviour, which is mostly a list of things it must NOT do.
 *
 * Universal cancels every gesture it owns — every engine it ships on pops its
 * own menu otherwise — so a classification mistake here does not degrade, it
 * replaces a working per-surface menu with the wrong one. The Radix bail and the
 * skip marker are the two guards that stop that, and both are mutation-tested
 * below (see the PR body for the red runs).
 */

import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const clipboard = { readClipboardText: vi.fn(async () => ''), writeClipboardText: vi.fn(async () => undefined) }

vi.mock('@/lib/clipboard', () => clipboard)
vi.mock('@/lib/platform', async importOriginal => ({
  ...((await importOriginal()) as Record<string, unknown>),
  IS_DESKTOP: true
}))

const windowsMock = { canOpenNewWindow: vi.fn(() => true) }

vi.mock('@/store/windows', async importOriginal => ({
  ...((await importOriginal()) as Record<string, unknown>),
  canOpenNewWindow: () => windowsMock.canOpenNewWindow()
}))

const { CONTEXT_MENU_ITEMS_AREA } = await import('./contrib')
const { AppContextMenu } = await import('./coordinator')
const { registry } = await import('@/contrib/registry')
const { registerTerminalContextMenu } = await import('@/app/right-pane/terminal/context-menu')
const { LONG_PRESS_MS } = await import('@/lib/long-press')
const { TAP_MAX_MS } = await import('@/lib/touch')
const { __resetContextMenu } = await import('./store')
const { I18nProvider } = await import('@/i18n')

function mountMenu() {
  return render(
    <I18nProvider>
      <AppContextMenu />
    </I18nProvider>
  )
}

/** A right-click, as an engine delivers it (`button: 2`). */
function rightClick(target: Element | Window, init: Partial<MouseEventInit> = {}) {
  const event = new MouseEvent('contextmenu', { bubbles: true, button: 2, cancelable: true, clientX: 20, clientY: 30, ...init })

  fireEvent(target, event)

  return event
}

const fixtures: HTMLElement[] = []

function fixture(html: string): HTMLElement {
  const host = document.createElement('div')

  host.innerHTML = html
  document.body.append(host)
  fixtures.push(host)

  return host
}

const releases: (() => void)[] = []

function contribute(id: string, data: unknown, order = 0) {
  releases.push(registry.register({ area: CONTEXT_MENU_ITEMS_AREA, data, id, order, source: 'core' }))
}

beforeEach(() => {
  clipboard.readClipboardText.mockReset().mockResolvedValue('')
  clipboard.writeClipboardText.mockReset().mockResolvedValue(undefined)
  windowsMock.canOpenNewWindow.mockReturnValue(true)
})

afterEach(() => {
  releases.splice(0).forEach(release => release())
  __resetContextMenu()
  // Remove only OUR nodes: clearing document.body would pull testing-library's
  // own container out from under its cleanup.
  fixtures.splice(0).forEach(host => host.remove())
  vi.useRealTimers()
})

describe('AppContextMenu — what a gesture opens', () => {
  it('opens the link section on a transcript link', () => {
    mountMenu()
    rightClick(fixture('<a href="https://example.test/docs">docs</a>').firstElementChild as Element)

    expect(screen.getByText('Open in external browser')).toBeTruthy()
    expect(screen.getByText('Copy URL')).toBeTruthy()
  })

  it('opens the image section with copy, address, save and open', () => {
    mountMenu()
    rightClick(fixture('<img src="data:image/png;base64,AA">').firstElementChild as Element)

    expect(screen.getByText('Copy image')).toBeTruthy()
    expect(screen.getByText('Copy image address')).toBeTruthy()
    expect(screen.getByText('Save image as…')).toBeTruthy()
  })

  it('opens the edit verbs in an editable, with accelerators and no icons', () => {
    mountMenu()

    const field = fixture('<textarea>hello world</textarea>').firstElementChild as HTMLTextAreaElement

    field.setSelectionRange(0, 5)
    rightClick(field)

    expect(screen.getByText('Cut')).toBeTruthy()
    expect(screen.getByText('Paste')).toBeTruthy()
    expect(screen.getByText('Select all')).toBeTruthy()
    // A native edit menu carries a faded accelerator, not an icon.
    expect(screen.getAllByText(/⌘X|Ctrl\+X/).length).toBe(1)
  })

  it('greys cut and copy when the field has text but no selection', () => {
    mountMenu()
    rightClick(fixture('<textarea>hello</textarea>').firstElementChild as Element)

    expect(screen.getByText('Cut').closest('[role="menuitem"]')?.getAttribute('data-disabled')).not.toBeNull()
    expect(screen.getByText('Select all').closest('[role="menuitem"]')?.getAttribute('data-disabled')).toBeNull()
  })

  it('greys every verb in an empty field', () => {
    mountMenu()
    rightClick(fixture('<textarea></textarea>').firstElementChild as Element)

    for (const label of ['Cut', 'Copy', 'Select all', 'Paste']) {
      expect(screen.getByText(label).closest('[role="menuitem"]')?.getAttribute('data-disabled')).not.toBeNull()
    }
  })

  it('greys Paste until the clipboard probe reports text', async () => {
    clipboard.readClipboardText.mockResolvedValue('pasted')
    mountMenu()
    rightClick(fixture('<textarea>x</textarea>').firstElementChild as Element)

    expect(screen.getByText('Paste').closest('[role="menuitem"]')?.getAttribute('data-disabled')).not.toBeNull()

    await vi.waitFor(() =>
      expect(screen.getByText('Paste').closest('[role="menuitem"]')?.getAttribute('data-disabled')).toBeNull()
    )
  })

  it('offers the shell verbs on bare chrome rather than an empty menu', () => {
    mountMenu()
    rightClick(fixture('<section>nothing here</section>').firstElementChild as Element)

    expect(screen.getByText('New session')).toBeTruthy()
    expect(screen.getByText('Command palette')).toBeTruthy()
    expect(screen.getByText('Check for updates')).toBeTruthy()
  })

  it('hides New session in window where a second window cannot be opened', () => {
    windowsMock.canOpenNewWindow.mockReturnValue(false)
    mountMenu()
    rightClick(fixture('<section>nothing here</section>').firstElementChild as Element)

    expect(screen.queryByText('New session in window')).toBeNull()
  })

  it('opens from the ContextMenu key (button 0) and records it as a keyboard gesture', () => {
    mountMenu()

    const event = rightClick(fixture('<textarea>draft</textarea>').firstElementChild as Element, { button: 0 })

    expect(event.defaultPrevented).toBe(true)
    expect(screen.getByText('Select all')).toBeTruthy()
  })
})

describe('AppContextMenu — the surfaces it stands down for', () => {
  it('leaves a surface with its own Radix menu completely alone', () => {
    mountMenu()

    // The statusbar's shape: an `asChild` child whose own `data-slot` erased the
    // Radix one, which is why the Hermes marker exists at all.
    const trigger = fixture('<button data-hermes-context-menu-trigger="" data-slot="statusbar">status</button>')
      .firstElementChild as Element

    const event = rightClick(trigger)

    expect(event.defaultPrevented).toBe(false)
    expect(screen.queryByText('New session')).toBeNull()
  })

  it('skips a PLAIN right-click inside a skip-marked surface', () => {
    mountMenu()

    const bubble = fixture('<div data-context-menu-skip=""><p>a message</p></div>')
    const event = rightClick(bubble.querySelector('p') as Element)

    expect(event.defaultPrevented).toBe(false)
    expect(screen.queryByText('New session')).toBeNull()
  })

  it('but NOT a link inside it — the marker is consulted after classification', () => {
    mountMenu()

    const bubble = fixture('<div data-context-menu-skip=""><a href="https://example.test/">link</a></div>')
    const event = rightClick(bubble.querySelector('a') as Element)

    expect(event.defaultPrevented).toBe(true)
    expect(screen.getByText('Copy URL')).toBeTruthy()
  })

  it('returns immediately when another capture listener already prevented it', () => {
    mountMenu()

    const field = fixture('<textarea>draft</textarea>').firstElementChild as Element
    const event = new MouseEvent('contextmenu', { bubbles: true, button: 2, cancelable: true })

    // What the ⌃Tab switcher's own capture listener does. Ordering between two
    // capture listeners is registration order, so this must not be assumed.
    event.preventDefault()
    fireEvent(field, event)

    expect(screen.queryByText('Select all')).toBeNull()
  })
})

describe('AppContextMenu — the terminal', () => {
  it('shows the terminal menu through a registered handle, not the DOM resolver', () => {
    mountMenu()

    const host = fixture('<div data-terminal=""><textarea class="xterm-helper-textarea"></textarea></div>')
      .firstElementChild as HTMLElement

    releases.push(
      registerTerminalContextMenu(host, {
        getSelection: () => 'ls -la',
        paste: () => undefined,
        selectAll: () => undefined
      })
    )

    // The gesture lands on xterm's hidden selection mirror — a real <textarea>.
    // A dom-first registry would call this an editable and offer Cut.
    rightClick(host.querySelector('textarea') as Element)

    expect(screen.getByText('Paste')).toBeTruthy()
    expect(screen.getByText('Select all')).toBeTruthy()
    expect(screen.queryByText('Cut')).toBeNull()
  })

  it('hides Paste entirely on the read-only agent mirror', () => {
    mountMenu()

    const host = fixture('<div data-terminal=""><span>output</span></div>').firstElementChild as HTMLElement

    releases.push(
      registerTerminalContextMenu(host, { getSelection: () => 'output', paste: null, selectAll: () => undefined })
    )
    rightClick(host.querySelector('span') as Element)

    expect(screen.getByText('Select all')).toBeTruthy()
    expect(screen.queryByText('Paste')).toBeNull()
  })
})

describe('AppContextMenu — plugin contributions', () => {
  it('appends contributed sections after the built-ins, in order', () => {
    contribute('later', { provide: () => [[{ key: 'b', label: 'Second plugin row', onSelect: () => undefined }]] }, 20)
    contribute('earlier', { provide: () => [[{ key: 'a', label: 'First plugin row', onSelect: () => undefined }]] }, 10)
    mountMenu()
    rightClick(fixture('<a href="https://example.test/">link</a>').firstElementChild as Element)

    const rows = screen.getAllByRole('menuitem').map(row => row.textContent)

    expect(rows.indexOf('First plugin row')).toBeGreaterThan(rows.indexOf('Copy URL'))
    expect(rows.indexOf('Second plugin row')).toBeGreaterThan(rows.indexOf('First plugin row'))
  })

  it('drops a contribution whose provide() throws, and says so in one disabled row', () => {
    contribute('broken', {
      provide: () => {
        throw new Error('plugin is wrong')
      }
    })
    mountMenu()
    rightClick(fixture('<a href="https://example.test/">link</a>').firstElementChild as Element)

    expect(screen.getByText('Copy URL')).toBeTruthy()
    expect(screen.getByText('Some items could not be loaded')).toBeTruthy()
  })

  it('contributes nothing for a target kind that is not open', () => {
    contribute('terminal-only', {
      provide: () => [[{ key: 'x', label: 'Terminal plugin row', onSelect: () => undefined }]],
      targets: ['terminal']
    })
    mountMenu()
    rightClick(fixture('<a href="https://example.test/">link</a>').firstElementChild as Element)

    expect(screen.queryByText('Terminal plugin row')).toBeNull()
    expect(screen.queryByText('Some items could not be loaded')).toBeNull()
  })
})

describe('AppContextMenu — the coarse-pointer path', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) => ({
        addEventListener: () => {},
        matches: query.includes('coarse'),
        removeEventListener: () => {}
      }),
      writable: true
    })
  })

  it('opens on a long press and swallows the trailing contextmenu', () => {
    vi.useFakeTimers()
    mountMenu()

    const link = fixture('<a href="https://example.test/">link</a>').firstElementChild as HTMLElement

    document.elementFromPoint = () => link

    fireEvent.pointerDown(link, { clientX: 20, clientY: 30 })
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS))

    expect(screen.getByText('Copy URL')).toBeTruthy()

    // The engine's own trailing gesture must not re-open (or worse, reach the
    // page) after ours already answered.
    const trailing = rightClick(link)

    expect(trailing.defaultPrevented).toBe(true)
  })

  it('does not swallow the NEXT right-click once the trailing one is consumed', () => {
    vi.useFakeTimers()
    mountMenu()

    const link = fixture('<a href="https://example.test/">link</a>').firstElementChild as HTMLElement

    document.elementFromPoint = () => link

    fireEvent.pointerDown(link, { clientX: 20, clientY: 30 })
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS))
    rightClick(link)

    // `fired()` stays true until the next `down()`, and a fine pointer never
    // arms one — so an unconsumed flag would swallow every later right-click on
    // a touchscreen laptop that once long-pressed. `defaultPrevented` cannot
    // tell the two apart (a swallow prevents it too), so assert the MENU.
    act(() => vi.advanceTimersByTime(TAP_MAX_MS + 1))
    act(() => void rightClick(fixture('<textarea>draft</textarea>').firstElementChild as Element))

    expect(screen.getByText('Select all')).toBeTruthy()
    expect(screen.queryByText('Copy URL')).toBeNull()
  })

  it('cancels the press when the finger moves — a slow scroll is not a menu', () => {
    vi.useFakeTimers()
    mountMenu()

    const link = fixture('<a href="https://example.test/">link</a>').firstElementChild as HTMLElement

    document.elementFromPoint = () => link

    fireEvent.pointerDown(link, { clientX: 20, clientY: 30 })
    fireEvent.pointerMove(link, { clientX: 20, clientY: 90 })
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS))

    expect(screen.queryByText('Copy URL')).toBeNull()
  })

  it('leaves a surface with its own long-press story to it', () => {
    vi.useFakeTimers()
    mountMenu()

    const square = fixture('<button data-hermes-context-menu-trigger="">profile</button>')
      .firstElementChild as HTMLElement

    document.elementFromPoint = () => square

    fireEvent.pointerDown(square, { clientX: 20, clientY: 30 })
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS))

    expect(screen.queryByText('New session')).toBeNull()
  })
})
