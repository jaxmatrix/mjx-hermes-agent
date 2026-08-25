import {
  type ComponentProps,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from 'react'

import { clearTableWidths, markdownTableKey, readTableWidths, writeTableWidths } from '@/lib/markdown-table-widths'
import { startPointerDrag } from '@/lib/pointer-drag'
import { cn } from '@/lib/utils'

/**
 * Drag-resizable columns for transcript markdown tables.
 *
 * Two choices keep this small:
 *
 * 1. A `<colgroup>` of percentages is the only state. Widths never touch the
 *    cells. One `<col>` per column, `table-layout: fixed`, and the browser does
 *    the rest — no per-cell measurement, no sticky header clone, no shadow copy
 *    of the table's contents.
 * 2. A drag moves exactly one seam. The pair either side of the handle trade
 *    width and their sum is preserved, so the table box never changes size
 *    mid-drag: no reflow of the message around it, no scrollbar appearing under
 *    the pointer.
 *
 * Handles are plain markup inside each `<th>`; the table listens once and
 * resolves which seam was grabbed from the DOM at pointer-down. No context, no
 * per-column component, no index threading — a column knows its position
 * because it *is* in that position.
 *
 * Until a table is resized it stays in auto layout, which is the better
 * default: the browser fits columns to their content. The colgroup only appears
 * once there is a width to state.
 *
 * A drag sets state on this component alone, and `children` is an already-built
 * element tree whose reference does not change, so React reconciles the
 * colgroup and bails out of the whole table body. That is what makes this safe
 * under streaming: the transcript re-parses the markdown on every token, and
 * the identity effect below re-derives the same shape key from the same header
 * row, so a re-render lands on the widths the drag left behind.
 */

/** A column can't be dragged narrower than this — below it the header label
 *  has no room and the seam becomes hard to grab back. */
const MIN_COLUMN_PX = 48

const equalWidths = (left: null | number[], right: null | number[]) =>
  left === right || (!!left && !!right && left.length === right.length && left.every((v, i) => v === right[i]))

export function ResizableMarkdownTable({ children, className, ...props }: ComponentProps<'table'>) {
  const tableRef = useRef<HTMLTableElement>(null)
  const keyRef = useRef<null | string>(null)
  // A drag owns the widths while it runs; the identity effect below must not
  // overwrite them from storage between two pointermove frames.
  const draggingRef = useRef(false)
  // The unmount half of the drag teardown. A transcript can drop the message
  // under the pointer mid-drag (session switch, a tile closing), and the drag
  // itself never hears about it.
  const cancelDragRef = useRef<null | (() => void)>(null)
  const [widths, setWidths] = useState<null | number[]>(null)

  useEffect(() => () => cancelDragRef.current?.(), [])

  // A markdown table has no identity of its own — it is re-parsed from text on
  // every render. Its header row is the identity: the same table in the same
  // message resolves to the same key after a re-render, a session switch, or a
  // reload, and two tables only collide when they are, column for column, the
  // same table.
  useLayoutEffect(() => {
    const cells = tableRef.current?.tHead?.rows[0]?.cells

    if (!cells || cells.length < 2) {
      keyRef.current = null

      return
    }

    const key = markdownTableKey(Array.from(cells, cell => cell.textContent?.trim() ?? ''))
    keyRef.current = key

    if (draggingRef.current) {
      return
    }

    const stored = readTableWidths(key, cells.length)
    setWidths(current => (equalWidths(current, stored) ? current : stored))
  }, [children])

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLTableElement>) => {
    const handle = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-md-col-handle]')
    const table = tableRef.current

    // `button` is 0 for a primary mouse button AND for a touch contact, so this
    // admits a finger while still rejecting a right-click.
    if (!handle || !table || event.button !== 0) {
      return
    }

    const cells = Array.from(table.tHead?.rows[0]?.cells ?? [])
    const index = cells.indexOf(handle.closest('th') as HTMLTableCellElement)
    const tableWidth = table.getBoundingClientRect().width

    // The last column has no seam of its own, and a zero-width table (one in a
    // collapsed pane) gives no denominator to work in.
    if (index < 0 || index >= cells.length - 1 || tableWidth <= 0) {
      return
    }

    // Claims the gesture: on touch this is what stops the transcript from
    // treating the drag as a scroll, together with `touch-action: none` on the
    // handle. WebKitGTK honours pointer capture on the element that got the
    // pointerdown, which is why it is set on the handle and not the table.
    event.preventDefault()
    handle.setPointerCapture(event.pointerId)
    handle.dataset.mdColActive = 'true'
    draggingRef.current = true

    // Seed from what is on screen, so the first drag continues the auto layout
    // the user was looking at instead of snapping to even columns. Measured
    // once, at pointer-down: nothing is re-measured mid-drag, so the transcript
    // cannot reflow under the pointer.
    const start = cells.map(cell => (cell.getBoundingClientRect().width / tableWidth) * 100)
    const pair = start[index] + start[index + 1]
    const min = Math.min((MIN_COLUMN_PX / tableWidth) * 100, pair / 2)
    const rtl = getComputedStyle(table).direction === 'rtl'
    const startX = event.clientX
    let next = start

    cancelDragRef.current = startPointerDrag(
      move => {
        const delta = ((rtl ? startX - move.clientX : move.clientX - startX) / tableWidth) * 100
        const leading = Math.min(Math.max(start[index] + delta, min), pair - min)

        next = start.map((value, at) => (at === index ? leading : at === index + 1 ? pair - leading : value))
        setWidths(next)
      },
      () => {
        cancelDragRef.current = null
        delete handle.dataset.mdColActive
        draggingRef.current = false

        // A cancelled gesture (Android stealing the pointer) still keeps what
        // the columns were showing when it was taken — the alternative is the
        // table snapping back under the finger.
        if (keyRef.current && next !== start) {
          writeTableWidths(keyRef.current, next)
        }
      }
    )
  }, [])

  // Double-click a seam to hand the columns back to auto layout — the same
  // reset gesture the pane sashes use.
  const onDoubleClick = useCallback((event: ReactMouseEvent<HTMLTableElement>) => {
    if (!(event.target as HTMLElement | null)?.closest('[data-md-col-handle]')) {
      return
    }

    if (keyRef.current) {
      clearTableWidths(keyRef.current)
    }

    setWidths(null)
  }, [])

  return (
    <div className="aui-md-table my-2 max-w-full overflow-x-auto rounded-[0.375rem] border border-(--ui-stroke-tertiary)">
      <table
        className={cn(
          'm-0 w-full min-w-[18rem] border-collapse text-[0.8125rem] [&_tr]:border-b [&_tr]:border-(--ui-stroke-tertiary) last:[&_tr]:border-0',
          widths && 'table-fixed [&_td]:wrap-anywhere',
          className
        )}
        onDoubleClick={onDoubleClick}
        onPointerDown={onPointerDown}
        ref={tableRef}
        {...props}
      >
        {widths && (
          <colgroup>
            {widths.map((width, index) => (
              <col key={index} style={{ width: `${width}%` }} />
            ))}
          </colgroup>
        )}
        {children}
      </table>
    </div>
  )
}

export function ResizableMarkdownTh({ children, className, ...props }: ComponentProps<'th'>) {
  return (
    <th
      className={cn(
        'relative px-2.5 py-1.5 text-start align-middle text-[0.75rem] font-medium text-muted-foreground',
        // The trailing column has no seam: its right edge is the table's edge,
        // and there is nothing on the far side to trade width with.
        '[&:last-child_[data-md-col-handle]]:hidden',
        className
      )}
      {...props}
    >
      {/* Truncation lives on an inner box, not the cell: the grab band straddles
          the cell's edge, so a clipping `<th>` would cut half of it off. */}
      <span className="block overflow-hidden text-ellipsis whitespace-nowrap">{children}</span>
      {/* Invisible grab band straddling the seam, with the hairline revealed on
          hover. `touch-action: none` is scoped to this band alone so a finger
          on the seam resizes while a finger anywhere else in the table still
          scrolls the transcript. */}
      <span
        aria-hidden
        className="group/mdcol absolute inset-y-0 -end-1 z-10 w-2 cursor-col-resize touch-none select-none"
        data-md-col-handle
      >
        <span className="absolute inset-0 mx-auto w-px bg-(--ui-stroke-secondary) opacity-0 transition-opacity duration-100 group-hover/mdcol:opacity-100 [[data-md-col-active]_&]:opacity-100" />
      </span>
    </th>
  )
}
