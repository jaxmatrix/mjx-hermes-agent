import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const setGuestVisible = vi.fn(() => Promise.resolve(true))

vi.mock('@/lib/browser/host', () => ({ setGuestVisible }))

const { $guestOccluded, __resetGuestOcclusion, claimGuestOcclusion } = await import('./browser-occlusion')

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
