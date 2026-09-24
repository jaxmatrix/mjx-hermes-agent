import fs from 'node:fs'
import path from 'node:path'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * Shiki and driver.js must never be reachable from the app entry through STATIC
 * imports.
 *
 * This is the assertion MJXHRM-380 was closed without. That ticket put
 * `lazy()` / dynamic `import()` in front of all four of the app's own shiki
 * entry points and measured the entry chunk shrink — and the engine still
 * loaded on every cold start, because `markdown-text.tsx` statically imported
 * `@streamdown/code`, which statically imports all of shiki. Four correct seams
 * defeated by a fifth importer nobody had enumerated. A byte-size check would
 * not have caught it either: the bytes DID move into a separate chunk; the
 * entry just kept a top-level static import OF that chunk.
 *
 * So the property worth asserting is reachability, not size — and it has to
 * cover node_modules, because that is where the defeat came from.
 *
 * One of those four seams remains: `codeToTokens` in the diff renderer, which
 * asks shiki for DATA and renders rows this app owns. The other three are gone
 * rather than deferred. The chat code fence (the iOS one-line collapse) and the
 * file preview's source view (the empty source pane, the same bug seen from the
 * other side) compute their colours from `lib/code-tokens`, and the diff's
 * `react-shiki` path was folded into the `codeToTokens` one, so `react-shiki` is
 * no longer a dependency at all. The assertions at the bottom of this file hold
 * all three to that.
 *
 * driver.js joined the list with the tour engine (MJXHRM-473). It is the same
 * shape of risk with a shorter fuse: `lib/tour/index.ts` pulls driver.js AND
 * two stylesheets, and the module that registers the tour driver is imported by
 * `main.tsx` at boot — so a `import { runTour } from '@/lib/tour'` written for
 * convenience instead of the dynamic import inside the driver would put the
 * whole engine on every cold start, silently.
 *
 * How it works: parse every module reachable from `src/main.tsx` following
 * static edges only (import declarations, side-effect imports, `export … from`
 * re-exports, `import x = require()`, and CommonJS `require()`), and stop at
 * every `import()` expression, which is a chunk boundary rather than an entry
 * edge. Type-only imports are erased by the bundler, so they are skipped here
 * too; the repo lints `@typescript-eslint/consistent-type-imports` as an error,
 * which is what makes "type-only" decidable from syntax alone.
 */

// `import.meta.url` is an http URL under Vite's transform, so the app root
// comes from the process instead: vitest runs rooted at this package.
const APP_DIR = process.cwd()
const REPO_ROOT = path.resolve(APP_DIR, '../..')
const SHARED_SRC = path.join(REPO_ROOT, 'apps/shared/src')
const SRC = path.join(APP_DIR, 'src')
const ENTRY = path.join(SRC, 'main.tsx')

/**
 * The one file whose `import()`s ARE boot edges. `app.tsx` picks the window's
 * root and loads it as a chunk, so each root is fetched during the cold start of
 * the window that mounts it — dynamic to the bundler, eager to the user, exactly
 * the distinction this file exists for. Stopping there would let shiki ride into
 * every desktop launch inside the root chunk with this guard still green, so the
 * walk crosses these boundaries and no others: the graph below is the union of
 * every window kind's cold start.
 */
const ROOT_PICKER = path.join(SRC, 'app.tsx')

/** Package names that must not appear on the entry's static graph. */
const FORBIDDEN = ['shiki', 'react-shiki', '@shikijs', '@streamdown/code', 'driver.js']

/**
 * Specifiers this walker cannot resolve, each verified by hand to be incapable
 * of reaching shiki. `#minpath` / `#minproc` / `#minurl` are vfile's private
 * node-vs-browser imports map; `react-remove-scroll-bar/constants` is a
 * two-constant module. A NEW entry here means the resolver has a blind spot —
 * check what it is before widening the list, because a blind spot is exactly
 * how an importer hides.
 */
const UNRESOLVED_ALLOWLIST = [
  '#minpath',
  '#minproc',
  '#minurl',
  'react-remove-scroll-bar/constants'
]

const RESOLVE_EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json']
const INDEX_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']

function resolveFile(candidate: string): string | null {
  for (const ext of RESOLVE_EXTENSIONS) {
    const withExt = candidate + ext

    if (fs.existsSync(withExt) && fs.statSync(withExt).isFile()) {
      return withExt
    }
  }

  for (const ext of INDEX_EXTENSIONS) {
    const index = path.join(candidate, `index${ext}`)

    if (fs.existsSync(index)) {
      return index
    }
  }

  return null
}

/** Pick the browser/ESM branch of an `exports` condition tree, as Vite does. */
function pickCondition(node: unknown): string | null {
  if (typeof node === 'string') {
    return node
  }

  if (!node || typeof node !== 'object') {
    return null
  }

  for (const key of ['browser', 'import', 'module', 'default', 'require']) {
    if (key in (node as Record<string, unknown>)) {
      const picked = pickCondition((node as Record<string, unknown>)[key])

      if (picked) {
        return picked
      }
    }
  }

  return null
}

function resolveBare(specifier: string, fromDir: string): string | null {
  const segments = specifier.split('/')
  const pkgName = specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]
  const subpath = `.${specifier.slice(pkgName.length)}`

  let dir = fromDir

  while (dir.startsWith(REPO_ROOT)) {
    const pkgDir = path.join(dir, 'node_modules', pkgName)
    const manifest = path.join(pkgDir, 'package.json')

    if (fs.existsSync(manifest)) {
      const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8')) as Record<string, unknown>
      const exportsField = pkg.exports as Record<string, unknown> | string | undefined
      let target: string | null = null

      if (typeof exportsField === 'string') {
        target = subpath === '.' ? exportsField : null
      } else if (exportsField) {
        target =
          exportsField[subpath] !== undefined
            ? pickCondition(exportsField[subpath])
            : subpath === '.'
              ? pickCondition(exportsField)
              : null
      }

      target ??= subpath === '.' ? ((pkg.module ?? pkg.main ?? 'index.js') as string) : subpath

      return resolveFile(path.join(pkgDir, target))
    }

    const parent = path.dirname(dir)

    if (parent === dir) {
      break
    }

    dir = parent
  }

  return null
}

function resolveSpecifier(specifier: string, fromFile: string): string | null {
  if (specifier.startsWith('@/')) {
    return resolveFile(path.join(SRC, specifier.slice(2)))
  }

  if (specifier === '@hermes/plugin-sdk') {
    return resolveFile(path.join(SRC, 'sdk/universal.ts'))
  }

  if (specifier.startsWith('@hermes/shared/')) {
    return resolveFile(path.join(SHARED_SRC, specifier.slice('@hermes/shared/'.length)))
  }

  if (specifier === '@hermes/shared') {
    return resolveFile(path.join(SHARED_SRC, 'index'))
  }

  if (specifier.startsWith('.')) {
    const joined = path.join(path.dirname(fromFile), specifier)

    return resolveFile(joined.replace(/\.tsx?$/, '')) ?? resolveFile(joined)
  }

  // Node builtins, inline data, and Vite virtual modules carry no app code.
  if (specifier.startsWith('node:') || specifier.startsWith('data:') || specifier.startsWith('virtual:')) {
    return null
  }

  return resolveBare(specifier, path.dirname(fromFile))
}

function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith('.tsx')) {
    return ts.ScriptKind.TSX
  }

  if (file.endsWith('.ts')) {
    return ts.ScriptKind.TS
  }

  if (file.endsWith('.jsx')) {
    return ts.ScriptKind.JSX
  }

  return ts.ScriptKind.JS
}

/** Every specifier this module pulls in WITHOUT crossing a chunk boundary. */
function staticSpecifiers(file: string): string[] {
  if (file.endsWith('.json') || file.endsWith('.css')) {
    return []
  }

  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.ESNext,
    false,
    scriptKind(file)
  )

  const found: string[] = []

  const literal = (node: ts.Expression | undefined): string | null =>
    node && ts.isStringLiteralLike(node) ? node.text : null

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause

      // `import type … from` and `import { type A, type B } from` are erased by
      // the bundler, so they create no edge. A default/namespace binding or any
      // value specifier means the module is really pulled in.
      const typeOnly =
        clause?.isTypeOnly === true ||
        (clause !== undefined &&
          clause.name === undefined &&
          clause.namedBindings !== undefined &&
          ts.isNamedImports(clause.namedBindings) &&
          clause.namedBindings.elements.every(element => element.isTypeOnly))

      const specifier = literal(node.moduleSpecifier)

      if (specifier && !typeOnly) {
        found.push(specifier)
      }
    } else if (ts.isExportDeclaration(node)) {
      // `export … from 'x'` re-hoists x into this module — the trap that turns
      // a dynamic import somewhere else back into a static edge.
      const specifier = literal(node.moduleSpecifier)

      if (specifier && !node.isTypeOnly) {
        found.push(specifier)
      }
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const specifier = literal(node.moduleReference.expression)

      if (specifier) {
        found.push(specifier)
      }
    } else if (ts.isCallExpression(node)) {
      // `import(...)` is the boundary we are asserting exists — never followed,
      // except out of the root picker, whose chunks load at boot (see above).
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const specifier = file === ROOT_PICKER ? literal(node.arguments[0]) : null

        if (specifier) {
          found.push(specifier)
        }

        return
      }

      if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        const specifier = literal(node.arguments[0])

        if (specifier) {
          found.push(specifier)
        }
      }
    }

    ts.forEachChild(node, visit)
  }

  ts.forEachChild(source, visit)

  return found
}

/**
 * `import()` specifiers evaluated at MODULE INITIALIZATION — i.e. not inside
 * any function body, so they run the moment the module is first evaluated.
 *
 * Such a call is "dynamic" to a bundler (the code lands in its own chunk) while
 * being eager to a user (the chunk is requested during boot anyway). The
 * reachability assertion above cannot see the difference, so this closes that
 * gap explicitly rather than leaving it as a hole the next importer can hide in.
 */
function eagerDynamicSpecifiers(file: string): string[] {
  if (file.endsWith('.json') || file.endsWith('.css')) {
    return []
  }

  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.ESNext,
    false,
    scriptKind(file)
  )

  const found: string[] = []

  const visit = (node: ts.Node): void => {
    // A function body defers everything inside it — stop descending.
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) {
      return
    }

    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      found.push((node.arguments[0] as ts.StringLiteralLike).text)
    }

    ts.forEachChild(node, visit)
  }

  ts.forEachChild(source, visit)

  return found
}

interface Graph {
  reached: Set<string>
  parent: Map<string, string>
  forbidden: { file: string; specifier: string }[]
  eager: { file: string; specifier: string }[]
  unresolved: Set<string>
}

function walkStaticGraph(): Graph {
  const reached = new Set<string>([ENTRY])
  const parent = new Map<string, string>()
  const forbidden: { file: string; specifier: string }[] = []
  const eager: { file: string; specifier: string }[] = []
  const unresolved = new Set<string>()
  const queue = [ENTRY]

  const isForbidden = (specifier: string): boolean =>
    FORBIDDEN.some(name => specifier === name || specifier.startsWith(`${name}/`))

  while (queue.length > 0) {
    const file = queue.shift() as string

    for (const specifier of eagerDynamicSpecifiers(file)) {
      if (isForbidden(specifier)) {
        eager.push({ file, specifier })
      }
    }

    for (const specifier of staticSpecifiers(file)) {
      if (isForbidden(specifier)) {
        forbidden.push({ file, specifier })
      }

      const resolved = resolveSpecifier(specifier, file)

      if (!resolved) {
        // Relative and aliased specifiers always resolve; asset imports carry
        // no JS. Only a bare specifier going missing is a real blind spot.
        if (
          !specifier.startsWith('.') &&
          !specifier.startsWith('@/') &&
          !/\.(css|svg|png|jpe?g|woff2?)$/.test(specifier)
        ) {
          unresolved.add(specifier)
        }

        continue
      }

      if (reached.has(resolved)) {
        continue
      }

      reached.add(resolved)
      parent.set(resolved, file)
      queue.push(resolved)
    }
  }

  return { eager, forbidden, parent, reached, unresolved }
}

function chainTo(graph: Graph, file: string): string[] {
  const chain: string[] = []
  let current: string | undefined = file

  while (current && chain.length < 64) {
    chain.push(path.relative(REPO_ROOT, current))
    current = graph.parent.get(current)
  }

  return chain.reverse()
}

describe('entry import graph', () => {
  const graph = walkStaticGraph()

  it('reaches the app through the entry at all', () => {
    // Guards the guard: if resolution broke, the walk would find nothing and
    // every assertion below would pass vacuously.
    expect(graph.reached.size).toBeGreaterThan(1_000)
    expect([...graph.reached].some(file => file.endsWith('/src/app.tsx'))).toBe(true)
    expect([...graph.reached].some(file => file.includes('/node_modules/streamdown/'))).toBe(true)
    // …and through the root picker's chunks, or the walk stopped at `app.tsx`.
    expect([...graph.reached].some(file => file.endsWith('/src/app/index.tsx'))).toBe(true)
    expect([...graph.reached].some(file => file.endsWith('/src/app/mobile-controller.tsx'))).toBe(true)
  })

  it('resolves every bare specifier it walks past, except the known-inert ones', () => {
    expect([...graph.unresolved].sort()).toEqual(UNRESOLVED_ALLOWLIST)
  })

  it('never reaches a lazy-only library through a static import', () => {
    const detail = graph.forbidden
      .map(
        hit =>
          `${hit.specifier} imported by ${path.relative(REPO_ROOT, hit.file)}\n  ${chainTo(graph, hit.file).join('\n  -> ')}`
      )
      .join('\n\n')

    expect(detail).toBe('')
  })

  it('never fires a lazy-only import() at module initialization', () => {
    // A top-level `void import('shiki')` is dynamic to the bundler and eager to
    // the user: own chunk, still fetched during boot. Reachability alone can't
    // tell the two apart, so say so separately.
    const detail = graph.eager.map(hit => `${hit.specifier} at module scope in ${path.relative(REPO_ROOT, hit.file)}`)

    expect(detail).toEqual([])
  })

  it('never pulls a lazy-only module itself onto the entry graph', () => {
    const modules = [...graph.reached]
      .filter(file => /node_modules\/(shiki|react-shiki|@shikijs|@streamdown\/code|driver\.js)\//.test(file))
      .map(file => `${path.relative(REPO_ROOT, file)}\n  ${chainTo(graph, file).join('\n  -> ')}`)

    expect(modules).toEqual([])
  })

  it('keeps the in-app browser act engine off the boot path', () => {
    // `engine.js` is imported `?raw` — a ~14 KB STRING of DOM code that is
    // injected into a guest webview, never executed here. Pulling it onto the
    // entry graph would cost every cold start the bytes for a feature most
    // sessions never open. Same shape of guard as driver.js above.
    const onGraph = [...graph.reached]
      .filter(file => file.includes('/src/lib/browser-act/'))
      .map(file => `${path.relative(REPO_ROOT, file)}\n  ${chainTo(graph, file).join('\n  -> ')}`)

    expect(onGraph).toEqual([])
  })

  it('keeps the Radix context-menu primitive out of the coordinator’s module graph', () => {
    // `components/ui/context-menu.tsx` stamps the coordinator's marker, so it
    // needs ONE constant from `app/context-menu/`. Importing anything else from
    // that subtree would drag the stores, the clipboard seam and the terminal
    // registry into every surface that renders a per-surface menu — which is why
    // `markers.ts` has no imports of its own.
    const primitive = fs.readFileSync(path.join(SRC, 'components/ui/context-menu.tsx'), 'utf8')
    const reached = [...primitive.matchAll(/from '(@\/app\/context-menu[^']*)'/g)].map(match => match[1])

    expect(reached).toEqual(['@/app/context-menu/markers'])
    expect(fs.readFileSync(path.join(SRC, 'app/context-menu/markers.ts'), 'utf8')).not.toContain('import ')
  })

  it('side-effect-boots every previously-named init* lever', () => {
    // MJXHRM-448 D-01: `initTranslucency()` was exported and never called.
    // Universal now applies translucency via a side-effect import of
    // `./store/translucency` (see main.tsx) — same contract as the named call:
    // the persisted lever must run on every cold start. Named `init*` imports
    // that ARE still used must still be called.
    const entry = fs.readFileSync(ENTRY, 'utf8')

    expect(entry).toMatch(/import ['"]\.\/store\/translucency['"]/)

    const imported = [...entry.matchAll(/\bimport \{([^}]*)\} from/g)]
      .flatMap(match => match[1].split(','))
      .map(name => name.trim())
      .filter(name => /^init[A-Z]/.test(name))

    for (const lever of imported) {
      expect([lever, entry.includes(`${lever}(`)]).toEqual([lever, true])
    }
  })

  it('keeps the lazy-only entry points behind a dynamic boundary', () => {
    // The complement of the assertions above: the seams must still EXIST, or
    // "not statically reachable" would be satisfied by deleting highlighting.
    const seams = [
      ['components/chat/diff-lines.tsx', "import('shiki')"],
      // The tour engine's two doors: the agent bridge (registered at boot from
      // main.tsx, so its import MUST be inside the driver callback) and the
      // curated tour the ⌘K palette runs.
      ['store/tour-bridge.ts', "await import('@/lib/tour')"],
      ['app/command-palette/curated-tour.ts', "await import('@/lib/tour')"],
      // The act engine's door: the actor is registered at BOOT from main.tsx
      // (a blocked `preview.act.request` cannot wait for a component), so its
      // import has to be inside the actor callback rather than at module scope.
      ['store/browser-bridge.ts', "await import('@/lib/browser-act/actor')"],
      ['lib/browser-act/actor.ts', "from '@/lib/browser-act/engine.js?raw'"]
    ] as const

    for (const [file, seam] of seams) {
      expect(fs.readFileSync(path.join(SRC, file), 'utf8')).toContain(seam)
    }
  })

  it('keeps `react-shiki` off the static entry graph', () => {
    // syntax-diff still imports `react-shiki` (desktop parity), but only behind
    // the lazy boundary covered above. The package may stay in package.json;
    // what matters is it is not a static reach from main.tsx.
    const onGraph = [...graph.reached]
      .filter(file => /node_modules\/react-shiki\//.test(file))
      .map(file => path.relative(REPO_ROOT, file))

    expect(onGraph).toEqual([])
  })

  it('keeps shiki out of the code fence and the preview source view entirely', () => {
    // Stronger than the seam list, and the point of the fence and source-view
    // rebuilds: these two must reach shiki by NO route — not statically, not
    // behind a lazy boundary, not at all. Their colours are computed by
    // `lib/code-tokens`, which is itself required to have no imports whatsoever,
    // so no chunk can fail to arrive and no engine can be refused by a CSP. A
    // pane with no chunk to wait for has no empty state to sit in.
    expect(fs.readFileSync(path.join(SRC, 'components/chat/code-fence.tsx'), 'utf8')).not.toMatch(/from '.*shiki/)
    // Static OR dynamic — the preview must not even have a chunk to await.
    // (Prose mentioning shiki is fine; this matches specifiers.)
    const noShikiSpecifier = /(?:from|import\()\s*'[^']*shiki/

    expect(fs.readFileSync(path.join(SRC, 'app/right-pane/preview/preview-source.tsx'), 'utf8')).not.toMatch(
      noShikiSpecifier
    )
    expect(fs.readFileSync(path.join(SRC, 'app/right-pane/preview/preview-file.tsx'), 'utf8')).not.toMatch(
      noShikiSpecifier
    )
    expect(fs.readFileSync(path.join(SRC, 'lib/code-tokens.ts'), 'utf8')).not.toMatch(/^import /m)
  })
})
