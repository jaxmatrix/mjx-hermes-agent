/**
 * EVERY key the UI asks for exists in the bundle.
 *
 * A missing plugin key does not throw — `translateFrom` returns the KEY, so a
 * typo ships as `roster.newRomm` rendered literally in the sidebar. That is a
 * failure nothing else in the repo catches: `check:i18n` audits core `en.ts` and
 * a plugin's bundles are deliberately outside it.
 *
 * So this reads the plugin's own sources for `t('…')` / `ctx.i18n.t('…')` calls
 * and resolves each against the bundle. Source-scanning is normally a smell;
 * here it is the only mechanism that can see a string literal that never
 * type-checks against anything.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { bundles } from './index'

// `import.meta.url` is a `jsdom:` URL under the browser environment, so the
// path is resolved from the vitest ROOT instead.
const ROOT = join(process.cwd(), 'src/plugins/hermes-bots')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(entry => {
    const path = join(dir, entry)

    if (statSync(path).isDirectory()) {
      return sourceFiles(path)
    }

    return /\.tsx?$/.test(entry) && !entry.includes('.test.') ? [path] : []
  })
}

/** `t('a.b')`, `t('a.b', x)` and `ctx.i18n.t('a.b')` — but not `t(variable)`. */
const KEY_CALL = /\bt\(\s*'([a-z][\w.]*)'/gi

function usedKeys(): { file: string; key: string }[] {
  return sourceFiles(ROOT).flatMap(file =>
    [...readFileSync(file, 'utf8').matchAll(KEY_CALL)].map(match => ({ file, key: match[1] }))
  )
}

const resolve = (key: string): unknown =>
  key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], bundles.en)

describe('the plugin i18n bundle', () => {
  it('is actually consulted — the scan finds keys to check', () => {
    // A green run over zero keys would be a test that cannot fail.
    expect(usedKeys().length).toBeGreaterThan(20)
  })

  it('defines every key the UI asks for', () => {
    const missing = usedKeys()
      .filter(({ key }) => resolve(key) === undefined)
      .map(({ file, key }) => `${key} (${file.slice(ROOT.length + 1)})`)

    expect(missing).toEqual([])
  })

  it('renders every value as a string, so a bad shape cannot reach the DOM', () => {
    for (const { key } of usedKeys()) {
      const value = resolve(key)

      expect(['function', 'string']).toContain(typeof value)
    }
  })
})
