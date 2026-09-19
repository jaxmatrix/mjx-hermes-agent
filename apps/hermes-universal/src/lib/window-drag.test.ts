import fs from 'node:fs'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { platform, win } = vi.hoisted(() => ({
  platform: { mac: false },
  win: { startDragging: vi.fn(async () => {}), toggleMaximize: vi.fn(async () => {}) }
}))

vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => win }))
vi.mock('@/lib/platform', () => ({
  get IS_MAC() {
    return platform.mac
  }
}))

import { installWindowDrag, isWindowDragPoint } from './window-drag'

const DRAG = '[-webkit-app-region:drag]'
const NO_DRAG = '[-webkit-app-region:no-drag]'

type Box = [left: number, top: number, width: number, height: number]

/** jsdom lays nothing out, so every element is given the box it would have. */
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  box: Box,
  className = '',
  parent: HTMLElement = document.body
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  const [left, top, width, height] = box

  node.className = className
  node.getBoundingClientRect = () => new DOMRect(left, top, width, height)
  parent.appendChild(node)

  return node
}

function press(
  target: Element,
  x: number,
  y: number,
  init: MouseEventInit = {}
): { mouse: MouseEvent; seen: string[] } {
  const seen: string[] = []
  const note = (event: Event): void => void seen.push(event.type)

  document.body.addEventListener('pointerdown', note)
  document.body.addEventListener('mousedown', note)

  const base: MouseEventInit = {
    bubbles: true,
    button: 0,
    cancelable: true,
    clientX: x,
    clientY: y,
    detail: 1,
    ...init
  }

  const mouse = new MouseEvent('mousedown', base)

  target.dispatchEvent(new MouseEvent('pointerdown', { ...base, detail: 0 }))
  target.dispatchEvent(mouse)

  document.body.removeEventListener('pointerdown', note)
  document.body.removeEventListener('mousedown', note)

  return { mouse, seen }
}

let disarm: () => void

beforeEach(() => {
  platform.mac = false
  win.startDragging.mockClear()
  win.toggleMaximize.mockClear()
  disarm = installWindowDrag()
})

afterEach(() => {
  disarm()
  document.body.replaceChildren()
})

describe('the drag region', () => {
  it('is a press inside an element desktop marks as drag', () => {
    const band = el('div', [0, 0, 800, 34], `h-full flex-1 ${DRAG}`)
    const title = el('span', [40, 8, 100, 18], '', band)

    expect(isWindowDragPoint(title, 60, 12)).toBe(true)
    expect(isWindowDragPoint(band, 400, 12)).toBe(true)
  })

  // Most of desktop's bands are `pointer-events-none` strips laid OVER the
  // content: the press targets whatever is underneath, never the band.
  it('is geometric: a press that lands in a band it did not hit still drags', () => {
    const content = el('main', [0, 0, 800, 600])

    el('div', [0, 0, 800, 34], `pointer-events-none absolute ${DRAG}`)

    expect(isWindowDragPoint(content, 400, 12)).toBe(true)
    expect(isWindowDragPoint(content, 400, 300)).toBe(false)
  })

  it('is not a no-drag element inside a drag one, nor a button there', () => {
    const band = el('div', [0, 0, 800, 34], DRAG)
    const tab = el('div', [100, 0, 120, 34], `group/tab relative ${NO_DRAG}`, band)
    const label = el('span', [110, 8, 60, 18], '', tab)
    const close = el('button', [700, 5, 24, 24], '', band)

    expect(isWindowDragPoint(label, 120, 12)).toBe(false)
    expect(isWindowDragPoint(close, 710, 12)).toBe(false)
    expect(isWindowDragPoint(band, 400, 12)).toBe(true)
  })

  // Chromium folds the regions in document order: a band laid over an earlier
  // no-drag strip takes the point back.
  it('lets a later region override an earlier one', () => {
    const strip = el('div', [0, 0, 800, 34], NO_DRAG)

    el('div', [600, 0, 200, 34], `pointer-events-none ${DRAG}`)

    expect(isWindowDragPoint(strip, 700, 12)).toBe(true)
    expect(isWindowDragPoint(strip, 300, 12)).toBe(false)
  })

  it('never takes a press from an interactive descendant or a floating layer', () => {
    const band = el('div', [0, 0, 800, 34], DRAG)

    for (const [tag, attrs] of [
      ['a', {}],
      ['input', {}],
      ['textarea', {}],
      ['select', {}],
      ['div', { role: 'button' }],
      ['div', { contenteditable: 'true' }],
      ['div', { role: 'menu' }],
      ['div', { role: 'dialog' }],
      ['div', { 'data-tauri-drag-region': '' }]
    ] as const) {
      const control = el(tag, [10, 5, 50, 20], '', band)

      Object.entries(attrs).forEach(([name, value]) => control.setAttribute(name, value))

      const inner = el('span', [12, 6, 10, 10], '', control)

      expect([tag, attrs, isWindowDragPoint(inner, 15, 10)]).toEqual([tag, attrs, false])
      control.remove()
    }
  })

  it('ignores a band that is not laid out', () => {
    const content = el('main', [0, 0, 800, 600])

    el('div', [0, 0, 0, 0], DRAG)

    expect(isWindowDragPoint(content, 0, 0)).toBe(false)
  })
})

describe('the lever', () => {
  it('starts the move on a primary press, and the page never sees the press', () => {
    const band = el('div', [0, 0, 800, 34], DRAG)
    const { mouse, seen } = press(band, 400, 12)

    expect(win.startDragging).toHaveBeenCalledOnce()
    expect(win.toggleMaximize).not.toHaveBeenCalled()
    expect(mouse.defaultPrevented).toBe(true)
    expect(seen).toEqual([])
  })

  it('toggles maximise on the second press', () => {
    const band = el('div', [0, 0, 800, 34], DRAG)

    press(band, 400, 12, { detail: 2 })

    expect(win.toggleMaximize).toHaveBeenCalledOnce()
    expect(win.startDragging).not.toHaveBeenCalled()
  })

  // The system zooms on the second RELEASE there, and not if the pointer moved.
  it('on macOS zooms on the release of the second press, where it was pressed', () => {
    platform.mac = true

    const band = el('div', [0, 0, 800, 34], DRAG)

    press(band, 400, 12, { detail: 2 })
    expect(win.toggleMaximize).not.toHaveBeenCalled()

    band.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: 400, clientY: 12, detail: 2 }))
    expect(win.toggleMaximize).toHaveBeenCalledOnce()

    press(band, 400, 12, { detail: 2 })
    band.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: 420, clientY: 12, detail: 2 }))
    expect(win.toggleMaximize).toHaveBeenCalledOnce()
  })

  it('leaves every other press alone: another button, a modifier, a control, the content', () => {
    const band = el('div', [0, 0, 800, 34], DRAG)
    const button = el('button', [700, 5, 24, 24], '', band)
    const content = el('main', [0, 34, 800, 566])

    const presses = [
      press(band, 400, 12, { button: 2 }),
      press(band, 400, 12, { button: 1 }),
      press(band, 400, 12, { ctrlKey: true }),
      press(band, 400, 12, { shiftKey: true }),
      press(band, 400, 12, { altKey: true }),
      press(band, 400, 12, { metaKey: true }),
      press(button, 710, 12),
      press(content, 400, 300)
    ]

    expect(win.startDragging).not.toHaveBeenCalled()
    expect(win.toggleMaximize).not.toHaveBeenCalled()

    for (const { mouse, seen } of presses) {
      expect(mouse.defaultPrevented).toBe(false)
      expect(seen).toEqual(['pointerdown', 'mousedown'])
    }
  })

  it('does not move the window for a touch press', () => {
    const band = el('div', [0, 0, 800, 34], DRAG)
    const touch = new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 400, clientY: 12 })

    Object.defineProperty(touch, 'pointerType', { value: 'touch' })
    band.dispatchEvent(touch)
    band.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 400, clientY: 12, detail: 1 }))

    expect(win.startDragging).not.toHaveBeenCalled()
  })

  it('is gone once disarmed', () => {
    const band = el('div', [0, 0, 800, 34], DRAG)

    disarm()
    press(band, 400, 12)

    expect(win.startDragging).not.toHaveBeenCalled()
  })
})

// The matcher reads the regions off the DOM by the exact class desktop writes.
// A resync that marks one some other way — a variant prefix, a stylesheet rule,
// a new inline style — would be a band that silently does not drag.
describe("desktop's markings", () => {
  const root = path.join(process.cwd(), 'src')

  const sources = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const file = path.join(dir, entry.name)

      if (entry.isDirectory()) {
        return sources(file)
      }

      return /\.(?:css|tsx?)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [file] : []
    })

  const files = sources(root).map(file => ({ file: path.relative(root, file), text: fs.readFileSync(file, 'utf8') }))

  it('are the unprefixed Tailwind class, and nothing else', () => {
    const tokens = files.flatMap(({ file, text }) =>
      [...text.matchAll(/(\S?)\[-webkit-app-region:([a-z-]+)\]/g)]
        // Prose quotes the class in backticks or brackets; a class list does not.
        .filter(match => !/^[`(]$/.test(match[1]))
        .map(match => ({ file, prefix: match[1], value: match[2] }))
    )

    expect(tokens.length).toBeGreaterThan(20)
    expect(tokens.filter(token => !['drag', 'no-drag'].includes(token.value))).toEqual([])
    // `md:[…]`, `hover:[…]`, `![…]`: a class the attribute selector cannot see.
    expect(tokens.filter(token => !['', "'", '"'].includes(token.prefix))).toEqual([])
  })

  it('include one inline style, which only exists mid-drag', () => {
    const inline = files
      .filter(({ file, text }) => file !== 'lib/window-drag.ts' && /WebkitAppRegion|appRegion\b/.test(text))
      .map(({ file }) => file)

    expect(inline).toEqual(['components/pane-shell/tree/renderer/tree-group.tsx'])
  })

  // Desktop's one stylesheet rule is `button { no-drag }`, which the matcher
  // carries as a selector. Universal's stylesheet declares none.
  it('include no stylesheet rule the matcher does not carry', () => {
    const declared = files
      .filter(({ file }) => file.endsWith('.css'))
      .flatMap(({ file, text }) => [...text.matchAll(/^\s*-webkit-app-region\s*:/gm)].map(() => file))

    expect(declared).toEqual([])

    const desktop = fs.readFileSync(path.join(process.cwd(), '../desktop/src/styles.css'), 'utf8')

    const rules = [...desktop.matchAll(/([^{}]+)\{[^{}]*-webkit-app-region\s*:\s*([a-z-]+)[^{}]*\}/g)].map(match => [
      match[1].trim().split('\n').pop()?.trim(),
      match[2]
    ])

    expect(rules).toEqual([['button', 'no-drag']])
  })
})
