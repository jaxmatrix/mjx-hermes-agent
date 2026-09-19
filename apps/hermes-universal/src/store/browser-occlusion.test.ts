import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const setGuestVisible = vi.fn(() => Promise.resolve(true))

vi.mock('@/lib/browser/host', () => ({ setGuestVisible }))

const { $guestOccluded, __resetGuestOcclusion, claimGuestOcclusion, watchGuestOccluders } =
  await import('./browser-occlusion')

describe('guest occlusion', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setGuestVisible.mockClear()
    __resetGuestOcclusion()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('hides IMMEDIATELY — a dialog must never open behind the guest, not for a frame', () => {
    claimGuestOcclusion('dialog')

    expect(setGuestVisible).toHaveBeenCalledWith(false)
    expect($guestOccluded.get()).toBe(true)
  })

  it('does not flash the page between two menus in a chain', () => {
    // Removing the show debounce turns this red: closing one menu and opening
    // the next would show the page and hide it again inside one frame.
    const first = claimGuestOcclusion('menu')
    setGuestVisible.mockClear()

    first()
    const second = claimGuestOcclusion('menu')

    vi.advanceTimersByTime(50)

    expect(setGuestVisible).not.toHaveBeenCalled()
    expect($guestOccluded.get()).toBe(true)

    second()
    vi.advanceTimersByTime(50)

    expect(setGuestVisible).toHaveBeenCalledWith(true)
  })

  it('counts nested claims and only shows when the last one releases', () => {
    const dialog = claimGuestOcclusion('dialog')
    const select = claimGuestOcclusion('select')

    setGuestVisible.mockClear()
    dialog()
    vi.advanceTimersByTime(50)

    expect(setGuestVisible).not.toHaveBeenCalled()

    select()
    vi.advanceTimersByTime(50)

    expect(setGuestVisible).toHaveBeenCalledWith(true)
  })

  it('ignores a release called twice', () => {
    // React StrictMode runs an effect's cleanup twice; a double decrement would
    // leave the guest hidden forever with nothing on screen to explain it.
    const release = claimGuestOcclusion('dialog')
    const other = claimGuestOcclusion('dialog')

    release()
    release()
    release()

    vi.advanceTimersByTime(50)
    expect($guestOccluded.get()).toBe(true)

    other()
    vi.advanceTimersByTime(50)
    expect($guestOccluded.get()).toBe(false)
  })
})

// `components/ui/` is desktop's, verbatim, and desktop's `<webview>` needs no
// claim — so the claim is read off what those primitives render.
describe('guest occlusion from the DOM', () => {
  const settle = () => new Promise(resolve => setTimeout(resolve, 0))

  const mount = (html: string): HTMLElement => {
    const portal = document.createElement('div')

    portal.innerHTML = html
    document.body.appendChild(portal)

    return portal
  }

  let disarm: () => void

  beforeEach(() => {
    __resetGuestOcclusion()
    setGuestVisible.mockClear()
    disarm = watchGuestOccluders()
  })

  afterEach(() => {
    disarm()
    document.body.replaceChildren()
  })

  it.each([
    ['a dialog', '<div role="dialog"></div>'],
    ['an alert', '<div role="alertdialog"></div>'],
    [
      'a dropdown, a popover, a select or the context menu',
      '<div data-radix-popper-content-wrapper><div role="menu"></div></div>'
    ],
    ['a route overlay', '<section data-overlay-surface=""></section>']
  ])('hides the guest while %s is on screen, and shows it again after', async (_name, html) => {
    const portal = mount(html)

    await settle()
    expect($guestOccluded.get()).toBe(true)
    expect(setGuestVisible).toHaveBeenCalledWith(false)

    portal.remove()
    await settle()
    expect($guestOccluded.get()).toBe(false)
  })

  it('leaves the page up for a tooltip, and for the composer’s completion drawer beside it', async () => {
    mount('<div data-radix-popper-content-wrapper><div role="tooltip">Reload</div></div>')
    mount('<div role="listbox"></div>')

    await settle()
    expect($guestOccluded.get()).toBe(false)
    expect(setGuestVisible).not.toHaveBeenCalled()
  })

  it('sees a surface that was already up when the pane mounted', () => {
    disarm()
    mount('<div role="dialog"></div>')
    disarm = watchGuestOccluders()

    expect($guestOccluded.get()).toBe(true)
  })

  it('gives the space back when the pane goes away under an open dialog', async () => {
    mount('<div role="dialog"></div>')
    await settle()

    disarm()
    expect($guestOccluded.get()).toBe(false)
  })
})
