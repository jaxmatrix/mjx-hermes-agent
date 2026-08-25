/**
 * Live-behaviour test for the transcript's resizable table: mounts the REAL
 * component and drives real pointer events, the way `floating-panes.test.tsx`
 * does for tiles.
 *
 * jsdom lays nothing out, so every rect is zero and the component's own
 * `tableWidth <= 0` guard would refuse every drag. The rects below are stubbed
 * per element — that is not test scaffolding around the logic, it IS the input
 * the logic reads at pointer-down, and one test deliberately leaves them at
 * zero to prove the guard still bites.
 *
 * Each test uses its own header labels: the width record is keyed by header
 * text, so distinct headers are what keeps the tests independent — and the one
 * pair that shares headers is doing so on purpose.
 */

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ResizableMarkdownTable, ResizableMarkdownTh } from './markdown-table'

const TABLE_WIDTH = 300

interface LiveListener {
  fn: unknown
  type: string
}

let live: LiveListener[] = []
let restoreListeners: () => void

const livePointer = () => live.filter(entry => entry.type.startsWith('pointer'))

beforeEach(() => {
  window.localStorage.clear()
  live = []

  const add = window.addEventListener.bind(window)
  const remove = window.removeEventListener.bind(window)

  window.addEventListener = ((type: string, fn: unknown, options?: AddEventListenerOptions | boolean) => {
    live.push({ fn, type })

    return add(type as keyof WindowEventMap, fn as EventListener, options)
  }) as typeof window.addEventListener

  window.removeEventListener = ((type: string, fn: unknown, options?: AddEventListenerOptions | boolean) => {
    const at = live.findIndex(entry => entry.type === type && entry.fn === fn)

    if (at >= 0) {
      live.splice(at, 1)
    }

    return remove(type as keyof WindowEventMap, fn as EventListener, options)
  }) as typeof window.removeEventListener

  restoreListeners = () => {
    window.addEventListener = add
    window.removeEventListener = remove
  }
})

afterEach(() => {
  cleanup()
  restoreListeners()
  vi.restoreAllMocks()
})

function Table({ headers, rows = 1 }: { headers: string[]; rows?: number }) {
  return (
    <ResizableMarkdownTable>
      <thead>
        <tr>
          {headers.map(header => (
            <ResizableMarkdownTh key={header}>{header}</ResizableMarkdownTh>
          ))}
        </tr>
      </thead>
      <tbody>
        {Array.from({ length: rows }, (_, row) => (
          <tr key={row}>
            {headers.map(header => (
              <td key={header}>{`${header} ${row}`}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </ResizableMarkdownTable>
  )
}

const table = () => document.querySelector('table')!
const handles = () => Array.from(document.querySelectorAll<HTMLElement>('[data-md-col-handle]'))
const cols = () => Array.from(document.querySelectorAll('col'))

/** Percent widths currently stated by the colgroup, rounded to 2dp. */
const widths = () => cols().map(col => Math.round(Number.parseFloat((col as HTMLElement).style.width) * 100) / 100)

/** jsdom measures nothing; give the table a box and equal columns. */
function measure(tableWidth = TABLE_WIDTH) {
  const cells = Array.from(document.querySelectorAll('th'))
  const each = tableWidth / cells.length

  table().getBoundingClientRect = () => ({ width: tableWidth }) as DOMRect

  for (const cell of cells) {
    cell.getBoundingClientRect = () => ({ width: each }) as DOMRect
  }
}

function fire(target: EventTarget, type: string, clientX: number) {
  const event = new MouseEvent(type, { bubbles: true, button: 0, clientX })

  Object.defineProperty(event, 'pointerId', { value: 1 })

  act(() => {
    target.dispatchEvent(event)
  })
}

/** Grab the seam after column `index` and move it by `dx` pixels. */
function dragSeam(index: number, dx: number, { release = true } = {}) {
  fire(handles()[index], 'pointerdown', 100)
  fire(window, 'pointermove', 100 + dx)

  if (release) {
    fire(window, 'pointerup', 100 + dx)
  }
}

describe('ResizableMarkdownTable', () => {
  it('renders in auto layout until a column is resized', () => {
    render(<Table headers={['Auto', 'Layout', 'Default']} />)

    expect(cols()).toHaveLength(0)
    expect(table().className).not.toContain('table-fixed')
  })

  it('resizes one seam, trading width with its neighbour and preserving the total', () => {
    render(<Table headers={['Name', 'Size', 'Modified']} />)
    measure()

    dragSeam(0, 30)

    // 30px of a 300px table is 10 points; only the dragged pair moves.
    expect(widths()).toEqual([43.33, 23.33, 33.33])
    expect(widths().reduce((sum, part) => sum + part, 0)).toBeCloseTo(100, 1)
    expect(table().className).toContain('table-fixed')
  })

  it('clamps a column at the minimum instead of collapsing it', () => {
    render(<Table headers={['Narrow', 'Wide', 'Rest']} />)
    measure()

    // Far past the left edge: column 0 must stop at 48px (16% of 300), not
    // cross zero and start eating its neighbour from the wrong side.
    dragSeam(0, -400)

    expect(widths()).toEqual([16, 50.67, 33.33])
  })

  it('keeps the widths through a streaming re-render of the same table', () => {
    const { rerender } = render(<Table headers={['Stream', 'Column', 'Set']} />)
    measure()

    dragSeam(0, 30)
    expect(widths()).toEqual([43.33, 23.33, 33.33])

    // Streaming appends rows: same header row, new children identity, over and
    // over. The shape key must resolve to the same record every time.
    for (const rows of [2, 3, 4]) {
      rerender(<Table headers={['Stream', 'Column', 'Set']} rows={rows} />)
      expect(widths()).toEqual([43.33, 23.33, 33.33])
    }

    expect(document.querySelectorAll('tbody tr')).toHaveLength(4)
  })

  it('does not let a streaming re-render pull the columns out from under a live drag', () => {
    const headers = ['Live', 'Drag', 'Stream']
    const { rerender } = render(<Table headers={headers} />)
    measure()

    fire(handles()[0], 'pointerdown', 100)
    fire(window, 'pointermove', 130)
    expect(widths()).toEqual([43.33, 23.33, 33.33])

    // A token lands WHILE the finger is down. The identity effect re-runs and
    // reads a record that does not exist yet, so without the drag guard it
    // resets the table to auto layout under the pointer.
    act(() => {
      rerender(<Table headers={headers} rows={3} />)
    })

    expect(widths()).toEqual([43.33, 23.33, 33.33])

    // ...and the drag is still tracking after the re-render, not orphaned.
    // 145 keeps the neighbour above the 48px floor; 160 would clamp and hide
    // whether the drag was still live at all.
    fire(window, 'pointermove', 145)
    expect(widths()).toEqual([48.33, 18.33, 33.33])

    fire(window, 'pointerup', 145)
    expect(widths()).toEqual([48.33, 18.33, 33.33])
  })

  it('restores the widths when the same table is mounted again (session switch)', () => {
    const headers = ['Restored', 'After', 'Switch']
    const first = render(<Table headers={headers} />)
    measure()

    dragSeam(0, 30)
    expect(widths()).toEqual([43.33, 23.33, 33.33])

    first.unmount()
    expect(cols()).toHaveLength(0)

    render(<Table headers={headers} />)

    expect(widths()).toEqual([43.33, 23.33, 33.33])
  })

  it('does not lend one table its widths to a differently-shaped one', () => {
    const first = render(<Table headers={['Shape', 'One', 'Here']} />)
    measure()

    dragSeam(0, 30)
    first.unmount()

    // Same column count, different headers: a different table.
    render(<Table headers={['Shape', 'Two', 'Here']} />)
    expect(cols()).toHaveLength(0)

    cleanup()

    // Same leading headers, different column count.
    render(<Table headers={['Shape', 'One', 'Here', 'Extra']} />)
    expect(cols()).toHaveLength(0)
  })

  it('hands the columns back to auto layout on a double-click, permanently', () => {
    const headers = ['Reset', 'Me', 'Please']
    const first = render(<Table headers={headers} />)
    measure()

    dragSeam(0, 30)
    expect(cols()).toHaveLength(3)

    act(() => {
      handles()[0].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })

    expect(cols()).toHaveLength(0)

    // Cleared from the record too, not just from this component's state.
    first.unmount()
    render(<Table headers={headers} />)

    expect(cols()).toHaveLength(0)
  })

  it('ignores the trailing seam, which has nothing to trade width with', () => {
    render(<Table headers={['Last', 'Seam', 'Ignored']} />)
    measure()

    dragSeam(2, 40)

    expect(cols()).toHaveLength(0)
  })

  it('ignores a drag in a collapsed pane, where there is no width to divide', () => {
    render(<Table headers={['Collapsed', 'Pane', 'Table']} />)
    measure(0)

    dragSeam(0, 30)

    expect(cols()).toHaveLength(0)
  })

  it('ignores a non-primary button', () => {
    render(<Table headers={['Right', 'Click', 'Table']} />)
    measure()

    const event = new MouseEvent('pointerdown', { bubbles: true, button: 2, clientX: 100 })
    Object.defineProperty(event, 'pointerId', { value: 1 })

    act(() => {
      handles()[0].dispatchEvent(event)
    })
    fire(window, 'pointermove', 130)

    expect(cols()).toHaveLength(0)
  })

  it('does not write a record for a click that never moved', () => {
    const headers = ['Clicked', 'Not', 'Dragged']
    const first = render(<Table headers={headers} />)
    measure()

    fire(handles()[0], 'pointerdown', 100)
    fire(window, 'pointerup', 100)

    first.unmount()
    render(<Table headers={headers} />)

    expect(cols()).toHaveLength(0)
  })

  it('tears every window listener down when the transcript unmounts mid-drag', () => {
    const { unmount } = render(<Table headers={['Unmounted', 'Mid', 'Drag']} />)
    measure()

    dragSeam(0, 30, { release: false })

    // Seeded to disagree: the drag must be LIVE here, or the assertion after
    // unmount would pass on a component that never started one.
    expect(livePointer().length).toBeGreaterThan(0)
    expect(widths()).toEqual([43.33, 23.33, 33.33])

    unmount()

    expect(livePointer()).toHaveLength(0)
  })

  it('releases its listeners when a touch gesture is cancelled', () => {
    render(<Table headers={['Cancelled', 'Touch', 'Drag']} />)
    measure()

    dragSeam(0, 30, { release: false })
    expect(livePointer().length).toBeGreaterThan(0)

    // Android steals the pointer: pointercancel arrives, pointerup never does.
    fire(window, 'pointercancel', 130)

    expect(livePointer()).toHaveLength(0)
    // What the columns were showing when the gesture was taken is kept, rather
    // than snapping back under the finger.
    expect(widths()).toEqual([43.33, 23.33, 33.33])
  })

  it('claims the pointer so a finger on the seam does not scroll the transcript', () => {
    render(<Table headers={['Touch', 'Action', 'None']} />)
    measure()

    const capture = vi.fn()
    handles()[0].setPointerCapture = capture

    const event = new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 100 })
    Object.defineProperty(event, 'pointerId', { value: 7 })
    const prevented = vi.spyOn(event, 'preventDefault')

    act(() => {
      handles()[0].dispatchEvent(event)
    })

    expect(capture).toHaveBeenCalledWith(7)
    expect(prevented).toHaveBeenCalled()
    // The scroll opt-out is scoped to the grab band alone, so a finger
    // anywhere else in the table still scrolls.
    expect(handles()[0].className).toContain('touch-none')
    expect(table().className).not.toContain('touch-none')

    fire(window, 'pointerup', 100)
  })
})
