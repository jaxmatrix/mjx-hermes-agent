import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HERMES_CONTEXT_MENU_TRIGGER_ATTR } from '@/app/context-menu/markers'

import { installNativeContextMenuGuard } from './native-context-menu'

const rightClick = (target: Element, init: MouseEventInit = {}): MouseEvent => {
  const event = new MouseEvent('contextmenu', { bubbles: true, button: 2, cancelable: true, ...init })

  target.dispatchEvent(event)

  return event
}

let disarm: () => void

beforeEach(() => {
  disarm = installNativeContextMenuGuard()
})

afterEach(() => {
  disarm()
  document.body.replaceChildren()
  vi.unstubAllEnvs()
})

describe('the native context menu guard', () => {
  // Desktop's listener: capture phase on `window`, stops propagation, and never
  // cancels — the reason the webview's menu would open beside it.
  it('cancels a gesture desktop’s menu took without cancelling', () => {
    const desktop = (event: Event): void => event.stopPropagation()

    window.addEventListener('contextmenu', desktop, true)

    try {
      expect(rightClick(document.body.appendChild(document.createElement('p'))).defaultPrevented).toBe(true)
      expect(rightClick(document.body.appendChild(document.createElement('textarea'))).defaultPrevented).toBe(true)
    } finally {
      window.removeEventListener('contextmenu', desktop, true)
    }
  })

  // Radix composes its trigger's handler with a `defaultPrevented` check: a
  // gesture cancelled before it gets there opens no menu at all.
  it('lets a Radix trigger see the gesture uncancelled, and cancels it afterwards if Radix did not', () => {
    const trigger = document.body.appendChild(document.createElement('div'))
    const row = trigger.appendChild(document.createElement('span'))
    const seen: boolean[] = []

    trigger.setAttribute(HERMES_CONTEXT_MENU_TRIGGER_ATTR, '')
    trigger.addEventListener('contextmenu', event => void seen.push(event.defaultPrevented))

    expect(rightClick(row).defaultPrevented).toBe(true)
    expect(seen).toEqual([false])

    const slotted = document.body.appendChild(document.createElement('div'))

    slotted.dataset.slot = 'context-menu-trigger'
    slotted.addEventListener('contextmenu', event => void seen.push(event.defaultPrevented))
    rightClick(slotted)

    expect(seen).toEqual([false, false])
  })

  it('in a dev build, leaves Shift + right-click to the webview, and to nothing else', () => {
    const desktop = vi.fn()

    window.addEventListener('contextmenu', desktop, true)

    try {
      const event = rightClick(document.body, { shiftKey: true })

      expect(event.defaultPrevented).toBe(false)
      expect(desktop).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('contextmenu', desktop, true)
    }
  })

  it('in a shipped build, Shift changes nothing', () => {
    vi.stubEnv('DEV', false)

    expect(rightClick(document.body, { shiftKey: true }).defaultPrevented).toBe(true)
  })

  it('is gone once disarmed', () => {
    disarm()

    expect(rightClick(document.body).defaultPrevented).toBe(false)
  })
})
