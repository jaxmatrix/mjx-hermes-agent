/**
 * A markdown table has no id, so the width record is keyed by the table's own
 * shape. These tests pin the two halves of that claim: the SAME shape must
 * resolve to the same record across a re-render, a session switch and a fresh
 * process, and a DIFFERENT shape must never inherit another table's widths.
 *
 * The module keeps an in-memory mirror seeded once from storage, so "a fresh
 * process" means a fresh module — `vi.resetModules()` + a dynamic import, with
 * localStorage left standing. Importing statically would test the mirror and
 * never the persistence.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const STORAGE_KEY = 'hermes.desktop.mdTableColumns.v1'
const DAY_MS = 24 * 60 * 60 * 1000
const EPOCH = new Date('2026-08-21T00:00:00Z').getTime()

/** A module instance with a cold in-memory mirror — i.e. an app restart. */
async function restart() {
  vi.resetModules()

  return import('./markdown-table-widths')
}

const stored = () => JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null')

beforeEach(() => {
  window.localStorage.clear()
  vi.useFakeTimers()
  vi.setSystemTime(EPOCH)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('markdownTableKey', () => {
  it('is stable for the same header row and differs for a different one', async () => {
    const { markdownTableKey } = await restart()

    expect(markdownTableKey(['Name', 'Size', 'Modified'])).toBe(markdownTableKey(['Name', 'Size', 'Modified']))
    expect(markdownTableKey(['Name', 'Size', 'Modified'])).not.toBe(markdownTableKey(['Name', 'Size', 'Owner']))
  })

  it('separates tables that differ only in column count', async () => {
    const { markdownTableKey } = await restart()

    expect(markdownTableKey(['A', 'B'])).not.toBe(markdownTableKey(['A', 'B', 'C']))
    // The count prefix is what stops a header containing the separator byte
    // from impersonating a table with a different number of columns.
    expect(markdownTableKey(['AB'])).not.toBe(markdownTableKey(['A', 'B']))
  })
})

describe('table width records', () => {
  it('reads back what was written for the same shape', async () => {
    const { markdownTableKey, readTableWidths, writeTableWidths } = await restart()
    const key = markdownTableKey(['Name', 'Size', 'Modified'])

    expect(readTableWidths(key, 3)).toBeNull()

    writeTableWidths(key, [50, 25, 25])

    expect(readTableWidths(key, 3)).toEqual([50, 25, 25])
  })

  it('does not hand a record to a table with a different column count', async () => {
    const { markdownTableKey, readTableWidths, writeTableWidths } = await restart()
    const key = markdownTableKey(['Name', 'Size', 'Modified'])

    writeTableWidths(key, [50, 25, 25])

    expect(readTableWidths(key, 2)).toBeNull()
    expect(readTableWidths(key, 4)).toBeNull()
  })

  it('keeps two differently-shaped tables independent', async () => {
    const { markdownTableKey, readTableWidths, writeTableWidths } = await restart()
    const first = markdownTableKey(['Name', 'Size'])
    const second = markdownTableKey(['Command', 'Effect'])

    writeTableWidths(first, [70, 30])
    writeTableWidths(second, [20, 80])

    expect(readTableWidths(first, 2)).toEqual([70, 30])
    expect(readTableWidths(second, 2)).toEqual([20, 80])
  })

  it('survives a restart', async () => {
    const first = await restart()
    const key = first.markdownTableKey(['Name', 'Size'])
    first.writeTableWidths(key, [64, 36])

    const second = await restart()

    expect(second.readTableWidths(second.markdownTableKey(['Name', 'Size']), 2)).toEqual([64, 36])
  })

  it('clears a record, and the clear survives a restart', async () => {
    const first = await restart()
    const key = first.markdownTableKey(['Name', 'Size'])
    first.writeTableWidths(key, [64, 36])
    first.clearTableWidths(key)

    expect(first.readTableWidths(key, 2)).toBeNull()

    const second = await restart()

    expect(second.readTableWidths(key, 2)).toBeNull()
  })

  it('drops records older than a week on load, and keeps fresh ones', async () => {
    const first = await restart()
    const stale = first.markdownTableKey(['Stale', 'Table'])
    first.writeTableWidths(stale, [30, 70])

    // Eight days later a fresh table is written; the stale one must not come
    // back with it.
    vi.setSystemTime(EPOCH + 8 * DAY_MS)

    const second = await restart()
    const fresh = second.markdownTableKey(['Fresh', 'Table'])
    second.writeTableWidths(fresh, [40, 60])

    expect(second.readTableWidths(stale, 2)).toBeNull()
    expect(second.readTableWidths(fresh, 2)).toEqual([40, 60])

    const third = await restart()

    expect(third.readTableWidths(fresh, 2)).toEqual([40, 60])
  })

  it('bounds the namespace, evicting the coldest tables first', async () => {
    const { markdownTableKey, readTableWidths, writeTableWidths } = await restart()
    const keys = Array.from({ length: 70 }, (_, index) => markdownTableKey([`Col${index}`, 'B']))

    keys.forEach((key, index) => {
      vi.setSystemTime(EPOCH + index * 1000)
      writeTableWidths(key, [50, 50])
    })

    // 70 written, 64 kept: the six coldest are gone, the newest survive.
    expect(Object.keys(stored().e)).toHaveLength(64)
    expect(readTableWidths(keys[0], 2)).toBeNull()
    expect(readTableWidths(keys[5], 2)).toBeNull()
    expect(readTableWidths(keys[6], 2)).toEqual([50, 50])
    expect(readTableWidths(keys[69], 2)).toEqual([50, 50])
  })

  it('ignores a record written by a different store version', async () => {
    const first = await restart()
    const key = first.markdownTableKey(['Name', 'Size'])
    first.writeTableWidths(key, [64, 36])

    const raw = stored()
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...raw, v: raw.v + 1 }))

    const second = await restart()

    expect(second.readTableWidths(key, 2)).toBeNull()
  })

  it('ignores malformed records rather than rendering a broken colgroup', async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        e: {
          negative: { t: EPOCH, w: [-10, 110] },
          notNumbers: { t: EPOCH, w: ['50', '50'] },
          single: { t: EPOCH, w: [100] },
          usable: { t: EPOCH, w: [45, 55] }
        },
        v: 1
      })
    )

    const { readTableWidths } = await restart()

    expect(readTableWidths('negative', 2)).toBeNull()
    expect(readTableWidths('notNumbers', 2)).toBeNull()
    expect(readTableWidths('single', 1)).toBeNull()
    expect(readTableWidths('usable', 2)).toEqual([45, 55])
  })
})
