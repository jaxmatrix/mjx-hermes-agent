/**
 * The curated tour's selectors have to keep matching real chrome.
 *
 * The engine REJECTS a whole tour whose selectors do not resolve rather than
 * starting a broken one, so a handle deleted in a refactor turns the ⌘K row
 * into "No element matches selector(s): …" — a failure with no test between it
 * and the user, because nothing else in the app reads a `data-tour` attribute.
 *
 * Asserted against the SOURCE rather than a render: the four surfaces live in
 * four separate trees (sidebar pane, composer, statusbar, and one narration
 * step), and mounting all of them to check an attribute is a shell test
 * pretending to be a unit one.
 */

import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { en } from '@/i18n/en'

import { curatedTourSteps } from './curated-tour'

const SRC = path.resolve(process.cwd(), 'src')

/**
 * Every `data-tour="…"` value DECLARED in JSX anywhere under src/.
 *
 * `.tsx`, and never a test file. Both exclusions are load-bearing: the first
 * pass scanned `.ts` too and every `.test.tsx`, so `store/tour-bridge.test.ts`
 * — whose fixture DOM seeds `data-tour="sidebar"` and `data-tour="composer"` —
 * satisfied the assertion on its own. Renaming the real handle in
 * `app/chat/sidebar/index.tsx` left this file green, which is the whole defect
 * class it exists to catch.
 */
function declaredHandles(): Set<string> {
  const handles = new Set<string>()

  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)

      if (entry.isDirectory()) {
        walk(full)
      } else if (/\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name)) {
        for (const match of fs.readFileSync(full, 'utf8').matchAll(/data-tour="([^"]+)"/g)) {
          handles.add(match[1] as string)
        }
      }
    }
  }

  walk(SRC)

  return handles
}

describe('curated tour', () => {
  const steps = curatedTourSteps(en)

  it('points every step at a handle the app actually declares', () => {
    const handles = declaredHandles()

    // Guards the guard: an empty scan would pass every assertion below.
    expect(handles.size).toBeGreaterThan(3)

    const wanted = steps
      .map(step => step.selector)
      .filter((selector): selector is string => selector !== undefined)
      .map(selector => selector.replace(/^\[data-tour="(.+)"]$/, '$1'))

    expect(wanted.length).toBeGreaterThan(0)
    // Not `toContain` per handle: the failure has to name WHICH one went away.
    expect(wanted.filter(handle => !handles.has(handle))).toEqual([])
  })

  it('addresses elements by identity, never by DOM position', () => {
    for (const step of steps) {
      if (step.selector !== undefined) {
        expect(step.selector, step.title).toMatch(/^\[data-tour="[^"]+"]$/)
      }
    }
  })

  it('says something at every stop', () => {
    // A step with no copy renders a bare spotlight with no popover — the tour
    // still "runs", and tells the user nothing.
    for (const step of steps) {
      expect(step.title.length, step.title).toBeGreaterThan(0)
      expect(step.text.length, step.title).toBeGreaterThan(0)
    }
  })
})
