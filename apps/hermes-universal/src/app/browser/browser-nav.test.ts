import { beforeEach, describe, expect, it, vi } from 'vitest'

import { __resetBrowserNav, activeBrowserNav, commandFocusedBrowser, registerBrowserNav } from './browser-nav'

function handle() {
  return { back: vi.fn(), forward: vi.fn(), reload: vi.fn(), stop: vi.fn() }
}

function pane(): HTMLElement {
  const element = document.createElement('div')
  const inner = document.createElement('input')

  element.appendChild(inner)
  document.body.appendChild(element)

  return element
}

beforeEach(() => {
  __resetBrowserNav()
  document.body.innerHTML = ''
})

describe('browser nav registry', () => {
  it('answers nothing when focus is elsewhere, so ⌘R falls back to the window', () => {
    const element = pane()

    registerBrowserNav(element, handle())
    ;(document.activeElement as HTMLElement | null)?.blur()

    expect(commandFocusedBrowser()).toBeNull()
  })

  it('answers for focus NESTED inside the pane', () => {
    const element = pane()
    const nav = handle()

    registerBrowserNav(element, nav)
    ;(element.firstChild as HTMLInputElement).focus()

    expect(commandFocusedBrowser()).toBe(nav)
  })

  it('commands only the FOCUSED pane when two exist', () => {
    // Making `activeBrowserNav` return the last registered turns this red: a
    // detached tile window can put a second pane on screen, and ⌘R would then
    // reload whichever mounted most recently.
    const first = pane()
    const second = pane()
    const firstNav = handle()
    const secondNav = handle()

    registerBrowserNav(first, firstNav)
    registerBrowserNav(second, secondNav)
    ;(second.firstChild as HTMLInputElement).focus()

    expect(activeBrowserNav()).toBe(secondNav)

    // With focus in NEITHER, two panes is ambiguous and the answer says so
    // rather than guessing.
    ;(second.firstChild as HTMLInputElement).blur()
    expect(activeBrowserNav()).toBeNull()
  })

  it('drives the lone pane even when focus is outside it', () => {
    const element = pane()
    const nav = handle()

    registerBrowserNav(element, nav)

    expect(activeBrowserNav()).toBe(nav)
  })

  it('stops answering after unregister', () => {
    const element = pane()
    const off = registerBrowserNav(element, handle())

    off()

    expect(activeBrowserNav()).toBeNull()
  })

  it('a LATER registration survives an older unregister for the same element', () => {
    // A remount registers the replacement before the old effect's cleanup runs.
    const element = pane()
    const first = handle()
    const second = handle()

    const offFirst = registerBrowserNav(element, first)

    registerBrowserNav(element, second)
    offFirst()

    expect(activeBrowserNav()).toBe(second)
  })
})
