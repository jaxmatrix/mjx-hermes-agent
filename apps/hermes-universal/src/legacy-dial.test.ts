// @vitest-environment node
import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * Nothing a person can reach dials the legacy client any more (MJXHRM-602 F3).
 *
 * Connect, select, launch, cloud sign-in and a peer's re-home all publish an
 * identity (`store/connections.ts`) and leave the dialling to desktop's boot
 * hook, through the bridge. Universal's own dial path — `connect*` and its
 * reconnect loop in `store/connection`, `connectGateway` in
 * `store/gateway-client`, the saved-target restore in `store/gateway-restore` —
 * lives on only until F4/F13 delete it, and until then only the files below may
 * name its entry points: the legacy modules themselves and their own tests. The
 * list may only SHRINK, and must be empty when the legacy path retires.
 */
const LEGACY_DIAL: Record<string, string[]> = {
  'store/connection': ['connect', 'connectCloud', 'connectLocal', 'connectSsh'],
  'store/gateway-client': ['connectGateway'],
  'store/gateway-restore': ['autoRestoreConnection', 'dialSavedTarget']
}

const ALLOWED = [
  'store/connection-reconnect-auth.test.ts',
  'store/connection-ssh.test.ts',
  'store/connection.test.ts',
  'store/connection.ts',
  'store/gateway-profile.test.ts',
  'store/gateway-restore.test.ts',
  'store/gateway-restore.ts',
  'store/gateway-tap.test.ts'
]

const CEILING = 8

// `import.meta.url` is an http URL under Vite's transform, so the app root
// comes from the process instead: vitest runs rooted at this package.
const SRC = path.join(process.cwd(), 'src')

// `import { a, b } from 'x'` and `const { a, b } = await import('x')`.
const NAMED = [
  /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"\n]+)['"]/g,
  /\{([^}]*)\}\s*=\s*await\s+import\(\s*['"]([^'"\n]+)['"]\s*\)/g
]

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const abs = path.join(dir, entry.name)

    return entry.isDirectory() ? sourceFiles(abs) : /\.tsx?$/.test(entry.name) ? [abs] : []
  })
}

function moduleOf(file: string, specifier: string): string {
  const abs = specifier.startsWith('@/')
    ? path.join(SRC, specifier.slice(2))
    : path.resolve(path.dirname(file), specifier)

  return path.relative(SRC, abs).split(path.sep).join('/')
}

/** The legacy dial entry points `file` takes by name. */
function legacyDialNames(file: string): string[] {
  const source = fs.readFileSync(file, 'utf8')

  return NAMED.flatMap(pattern =>
    [...source.matchAll(pattern)].flatMap(([, names, specifier]) => {
      const legacy = LEGACY_DIAL[moduleOf(file, specifier)] ?? []

      return names
        .split(',')
        .map(
          name =>
            name
              .trim()
              .replace(/^type\s+/, '')
              .split(/\s+as\s+/)[0]
        )
        .filter(name => legacy.includes(name))
    })
  )
}

describe('the legacy dial path', () => {
  const callers = sourceFiles(SRC)
    .filter(file => legacyDialNames(file).length > 0)
    .map(file => path.relative(SRC, file).split(path.sep).join('/'))
    .sort()

  it('is found by a scan that sees imports at all', () => {
    expect(callers).toContain('store/gateway-restore.ts')
  })

  it('is named only by the legacy modules and their own tests', () => {
    expect(callers.filter(file => !ALLOWED.includes(file))).toEqual([])
  })

  it('gains no callers', () => {
    expect(ALLOWED).toHaveLength(CEILING)
    expect(callers.length).toBeLessThanOrEqual(CEILING)
  })

  it("has no soft switch of its own left: desktop's boot hook owns that", () => {
    expect(fs.existsSync(path.join(SRC, 'store/gateway-soft-switch.ts'))).toBe(false)
    expect(sourceFiles(SRC).filter(file => /gateway-soft-switch['"]/.test(fs.readFileSync(file, 'utf8')))).toEqual([])
  })
})
