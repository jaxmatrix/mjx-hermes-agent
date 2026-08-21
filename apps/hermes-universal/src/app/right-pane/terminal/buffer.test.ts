/**
 * The `read_terminal` seam (MJXHRM-472).
 *
 * Two things can go wrong here and neither shows up as an error: reading the
 * WRONG terminal (universal has a tab per shell, all mounted at once), and
 * answering a window the tool then mis-reports. Both are asserted against
 * fixtures that disagree with the expected answer — two registered readers with
 * different contents, and windows that run off the end of the buffer.
 */

import type { Terminal } from '@xterm/xterm'
import { beforeEach, describe, expect, it } from 'vitest'

import { $activeTerminalId } from '@/store/terminals'

import { makeTerminalReader, readActiveTerminal, registerTerminalReader } from './buffer'

/** A stand-in for xterm's buffer: `lines` are absolute, oldest first. */
const fakeTerm = (lines: string[], { baseY = 0, cursorY = 0, rows = 3 } = {}) =>
  ({
    buffer: {
      active: {
        baseY,
        cursorY,
        getLine: (i: number) => (i < lines.length ? { translateToString: () => lines[i] } : undefined),
        length: lines.length
      }
    },
    rows
  }) as unknown as Terminal

const SCROLLBACK = ['one', 'two', 'three', 'four', 'five', 'six']

const disposers: (() => void)[] = []

beforeEach(() => {
  while (disposers.length) {
    disposers.pop()?.()
  }

  $activeTerminalId.set(null)
})

describe('readActiveTerminal', () => {
  it('answers null when no terminal is mounted — the tool reports "no in-app terminal"', () => {
    expect(readActiveTerminal()).toBeNull()
  })

  // The failure this pins: an id is selected but its view was never mounted (a
  // tab in the store with no live xterm). Answering another terminal's buffer
  // would be worse than answering nothing.
  it('answers null when the ACTIVE id has no registered reader, even though others do', () => {
    disposers.push(registerTerminalReader('term-1', makeTerminalReader(fakeTerm(SCROLLBACK))))
    $activeTerminalId.set('term-2')

    expect(readActiveTerminal()).toBeNull()
  })

  // The multi-tile identity requirement: "the terminal" is the tab the user has
  // fronted, never whichever registered first.
  it('reads the ACTIVE terminal, not the first-registered one', () => {
    disposers.push(registerTerminalReader('term-1', makeTerminalReader(fakeTerm(['first shell']))))
    disposers.push(registerTerminalReader('term-2', makeTerminalReader(fakeTerm(['second shell']))))

    $activeTerminalId.set('term-2')
    expect(readActiveTerminal()?.text).toBe('second shell')

    $activeTerminalId.set('term-1')
    expect(readActiveTerminal()?.text).toBe('first shell')
  })

  it('stops answering for a terminal that unregistered, without dropping its replacement', () => {
    const stale = registerTerminalReader('term-1', makeTerminalReader(fakeTerm(['stale'])))

    disposers.push(registerTerminalReader('term-1', makeTerminalReader(fakeTerm(['live']))))
    // The stale disposer must be a no-op: it no longer owns the id.
    stale()
    $activeTerminalId.set('term-1')

    expect(readActiveTerminal()?.text).toBe('live')
  })
})

describe('makeTerminalReader', () => {
  const read = (options = {}, term = fakeTerm(SCROLLBACK, { baseY: 3, cursorY: 1 })) =>
    makeTerminalReader(term)(options)

  // No arguments = the visible screen, which starts at baseY, NOT at line 0.
  // Seeding baseY: 3 makes the two disagree.
  it('defaults to the viewport, not the top of the scrollback', () => {
    expect(read()).toEqual({
      cursor_row: 4,
      end: 6,
      start: 3,
      text: 'four\nfive\nsix',
      total_lines: 6,
      viewport_rows: 3
    })
  })

  it('pages the scrollback from an explicit start/count', () => {
    const result = read({ count: 2, start: 1 })

    expect(result.text).toBe('two\nthree')
    expect(result.start).toBe(1)
    expect(result.end).toBe(3)
  })

  // The tool documents valid lines as [0, total_lines); a model that pages past
  // the end must get an empty window, not a crash or a wrapped read.
  it('clamps a window that runs off the end of the buffer', () => {
    const result = read({ count: 50, start: 99 })

    expect(result.start).toBe(6)
    expect(result.end).toBe(6)
    expect(result.text).toBe('')
  })

  it('trims the blank rows an unfilled screen leaves behind', () => {
    const result = read({ count: 4, start: 0 }, fakeTerm(['one', 'two', '', '   ']))

    expect(result.text).toBe('one\ntwo')
    // The trim is presentational: total_lines still describes the real buffer,
    // so paging stays consistent with what the tool told the model.
    expect(result.total_lines).toBe(4)
  })
})
