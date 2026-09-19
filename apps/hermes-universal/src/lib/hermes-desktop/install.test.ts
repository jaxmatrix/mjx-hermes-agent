import fs from 'node:fs'
import path from 'node:path'

import ts from 'typescript'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The bridge has to exist before any module that reads `window.hermesDesktop`
// at module scope evaluates. ES imports evaluate before the importing module's
// body, so that is a property of `main.tsx`'s import ORDER and of what the
// install module's own static graph drags in ahead of it.

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/plugin-os', () => ({ platform: () => 'linux' }))

const SRC = path.join(process.cwd(), 'src')

function resolveSource(specifier: string, fromFile: string): null | string {
  const base = specifier.startsWith('@/')
    ? path.join(SRC, specifier.slice(2))
    : specifier.startsWith('.')
      ? path.resolve(path.dirname(fromFile), specifier)
      : null

  return base
    ? ([base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')].find(
        file => fs.existsSync(file) && fs.statSync(file).isFile()
      ) ?? null)
    : null
}

/** A file's static, value-carrying edges, in source order. */
function staticImports(file: string): string[] {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest)

  return source.statements.flatMap(statement => {
    const typeOnly =
      (ts.isImportDeclaration(statement) && statement.importClause?.isTypeOnly) ||
      (ts.isExportDeclaration(statement) && statement.isTypeOnly)

    const specifier =
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && statement.moduleSpecifier

    return specifier && !typeOnly && ts.isStringLiteral(specifier) ? [specifier.text] : []
  })
}

function staticGraph(entry: string, seen = new Set<string>()): Set<string> {
  if (seen.has(entry) || !/\.tsx?$/.test(entry)) {
    return seen
  }

  seen.add(entry)

  for (const specifier of staticImports(entry)) {
    const file = resolveSource(specifier, entry)

    if (file) {
      staticGraph(file, seen)
    }
  }

  return seen
}

beforeEach(() => {
  vi.resetModules()
  delete (window as { hermesDesktop?: unknown }).hermesDesktop
})

describe('the bridge install', () => {
  it('is an import side effect, so a module imported after it evaluates against the bridge', async () => {
    expect(window.hermesDesktop).toBeUndefined()

    await import('./install')

    expect(window.hermesDesktop).toMatchObject({ api: expect.any(Function), getConnection: expect.any(Function) })
  })

  it('installs once: a second evaluation keeps the bridge consumers already hold', async () => {
    await import('./install')

    const installed = window.hermesDesktop

    vi.resetModules()
    await import('./install')

    expect(window.hermesDesktop).toBe(installed)
  })

  it('is the entry’s second import, behind the persisted-tab migration alone', () => {
    const entry = path.join(SRC, 'main.tsx')

    expect(staticImports(entry).slice(0, 2)).toEqual([
      './store/persisted-tiles-migration',
      './lib/hermes-desktop/install'
    ])
    // One install path: the entry's body does not install it again.
    expect(fs.readFileSync(entry, 'utf8')).not.toContain('installHermesDesktopBridge')
  })

  it('evaluates nothing that reads persisted tabs or closes a cycle through `@/hermes`', () => {
    const reached = [...staticGraph(path.join(SRC, 'lib/hermes-desktop/install.ts'))].map(file =>
      path.relative(SRC, file)
    )

    expect(reached).toContain(path.join('lib', 'hermes-desktop', 'connections.ts'))

    for (const file of [
      'hermes.ts',
      'store/active-connection.ts',
      'store/connection-tunnels.ts',
      'store/connections.ts',
      'store/gateway.ts',
      'store/session-states.ts',
      'store/windows.ts'
    ]) {
      expect(reached).not.toContain(path.normalize(file))
    }
  })
})
