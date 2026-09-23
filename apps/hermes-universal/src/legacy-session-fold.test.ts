// @vitest-environment node
import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * The old session fold may only SHRINK (MJXHRM-602).
 *
 * `store/session-states` is desktop's, verbatim. Universal's session-key fold
 * lives on beside it in four legacy modules until fold steps 6–8 retire it, and
 * until then nothing new may be built on them. Each number is the count of files
 * (tests included) that import the module today: it may only be LOWERED, and all
 * four must reach 0 when the old fold retires.
 *
 * `lib/session-key-messages` is the fold's message model (was
 * `lib/chat-messages.ts`, which shadowed desktop's `lib/chat-messages/`). Its
 * `ChatMessage` is NOT desktop's: a file that needs desktop's imports
 * `@/lib/chat-messages`, never both.
 */
const CEILINGS: Record<string, number> = {
  'lib/session-key-messages': 31,
  'store/session-key-states': 27,
  'store/session-route-dispatch': 14,
  'store/session-state-types': 64
}

// `import.meta.url` is an http URL under Vite's transform, so the app root
// comes from the process instead: vitest runs rooted at this package.
const SRC = path.join(process.cwd(), 'src')
const SPECIFIER = /['"]((?:@\/|\.{1,2}\/)[^'"\n]*)['"]/g

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const abs = path.join(dir, entry.name)

    return entry.isDirectory() ? sourceFiles(abs) : /\.tsx?$/.test(entry.name) ? [abs] : []
  })
}

/** Every module under `src/` a file names — static, dynamic or `vi.mock`. */
function modulesNamedBy(file: string): Set<string> {
  const named = new Set<string>()

  for (const [, specifier] of fs.readFileSync(file, 'utf8').matchAll(SPECIFIER)) {
    const abs = specifier.startsWith('@/')
      ? path.join(SRC, specifier.slice(2))
      : path.resolve(path.dirname(file), specifier)

    named.add(path.relative(SRC, abs).split(path.sep).join('/'))
  }

  return named
}

describe('the legacy session fold', () => {
  const files = sourceFiles(SRC).map(file => ({ file, named: modulesNamedBy(file) }))

  const importersOf = (module: string) => files.filter(({ named }) => named.has(module)).length

  it('is counted by a scan that sees imports at all', () => {
    expect(importersOf('store/session-states')).toBeGreaterThan(0)
  })

  it.each(Object.entries(CEILINGS))('%s gains no importers', (module, ceiling) => {
    expect(importersOf(module)).toBeLessThanOrEqual(ceiling)
  })
})
