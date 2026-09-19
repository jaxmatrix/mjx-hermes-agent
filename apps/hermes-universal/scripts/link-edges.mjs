#!/usr/bin/env node
/**
 * Link-edge meter: every import the bundler will refuse to link.
 *
 * `vite build` does not typecheck, so a name imported from a module that does
 * not export it is a blank screen, not a squiggle — and the bundler's own
 * report is a wall of ANSI with no ranking. This walks the import graph from
 * the real entry exactly as the bundler sees it and lists every
 * (importer, provider, symbol) the link step will reject, ranked by which
 * provider unblocks the most files.
 *
 *   node scripts/link-edges.mjs                    # ranked text report
 *   node scripts/link-edges.mjs --json             # machine-readable
 *   node scripts/link-edges.mjs --entry src/x.tsx  # another entry
 *   node scripts/link-edges.mjs --provider src/store/session.ts
 *   node scripts/link-edges.mjs --top 25           # cap the provider table
 *   node scripts/link-edges.mjs --serve            # dev-server aliases, not build
 *   node scripts/link-edges.mjs --max-edges 120    # ratchet: exit 1 above N
 *   node scripts/link-edges.mjs --without src/app.tsx   # what if this file were gone (repeatable)
 *
 * It is a meter: exit code 0 whatever it finds, unless `--max-edges` is passed
 * and exceeded.
 *
 * THE ERASURE RULE. The app transforms each file in isolation (oxc, with
 * `isolatedModules` and no `verbatimModuleSyntax`), which is TypeScript's own
 * import elision done syntactically:
 *
 *   - `import type …`, `import { type X }`, `export type … from` and
 *     `export { type X } from` are erased — never an edge.
 *   - A plain import binding is an edge only if the file references it in a
 *     VALUE position: an expression, a JSX tag, `extends`, a shorthand
 *     property, or a local `export { X }`. A binding used only in type
 *     positions is dropped, and an import whose every binding is dropped
 *     disappears entirely — the module is not even loaded through it.
 *   - `export { X } from './m'` is always an edge: nothing in the file can
 *     prove X is a type, so the transform keeps it.
 *   - A provider exports only what survives the same transform: `interface`,
 *     `type`, `declare` and type-only namespaces are not there to link against.
 *   - A name a module merely forwards (`export { X } from`, or import then
 *     `export { X }`) is followed to its origin, as the bundler does: a name
 *     missing at the origin fails at the forwarding module and again at every
 *     importer of it. Those repeats are tagged `cascade` — fix the origin.
 *
 * Value use is decided by identifier text, not by scope, so a local that
 * shadows an import binding reads as a use. That can only over-report, and only
 * when the shadowed import is also missing from its provider.
 *
 * Not checked: names destructured from a dynamic `import()`, and
 * `import.meta.glob` `import:` options. A dynamic import behind
 * `import.meta.env.DEV` is walked although the build drops it, so the module
 * count can run a few over the bundler's. Property reads off `import * as ns` are
 * listed separately — the bundler warns on those rather than failing.
 */

import fs from 'node:fs'
import { builtinModules } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'

const APP = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const SRC = path.join(APP, 'src')
const SYNC_DIR = path.join(APP, 'sync')

// --------------------------------------------------------------------------
// Arguments
// --------------------------------------------------------------------------

const argv = process.argv.slice(2)
const flag = name => argv.includes(name)
const option = name => {
  const i = argv.indexOf(name)
  return i === -1 ? undefined : argv[i + 1]
}

const asJson = flag('--json')
const serve = flag('--serve')
const providerFilter = option('--provider')
const maxEdges = option('--max-edges') === undefined ? undefined : Number(option('--max-edges'))
const top = option('--top') === undefined ? Infinity : Number(option('--top'))

/** Files to pretend are absent — the reading a delete would give, before making it. */
const without = argv.flatMap((arg, i) => (arg === '--without' && argv[i + 1] ? [path.resolve(APP, argv[i + 1])] : []))

const rel = abs => path.relative(APP, abs).split(path.sep).join('/')
const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

// --------------------------------------------------------------------------
// The entry and the bundler's resolve options
// --------------------------------------------------------------------------

/** The module scripts `index.html` loads — what the bundler starts from. */
function htmlEntries() {
  const html = fs.readFileSync(path.join(APP, 'index.html'), 'utf8')
  const entries = []
  for (const [tag] of html.matchAll(/<script\b[^>]*>/g)) {
    if (!/type=["']module["']/.test(tag)) continue
    const src = tag.match(/\bsrc=["']([^"']+)["']/)?.[1]
    if (src) entries.push(path.join(APP, src.replace(/^\//, '')))
  }
  return entries
}

/**
 * Aliases, extensions and conditions from the app's own vite.config.ts, loaded
 * through Vite so conditional aliases (the tracing wrappers are dev-only)
 * resolve the way the chosen command resolves them.
 */
async function bundlerResolveOptions() {
  const { resolveConfig } = await import('vite')
  const config = serve
    ? await resolveConfig({ root: APP, logLevel: 'silent' }, 'serve', 'development', 'development')
    : await resolveConfig({ root: APP, logLevel: 'silent' }, 'build', 'production', 'production')
  return {
    alias: config.resolve.alias.filter(entry => !String(entry.find).includes('@vite')),
    extensions: config.resolve.extensions,
    conditions: new Set(['import', 'module', 'browser', 'default', serve ? 'development' : 'production'])
  }
}

/** tsconfig `paths`, only to say when a specifier resolves there and NOT in the bundler. */
function tsconfigPaths() {
  const file = path.join(APP, 'tsconfig.json')
  const { config } = ts.readConfigFile(file, ts.sys.readFile)
  return Object.entries(config?.compilerOptions?.paths ?? {}).map(([pattern, targets]) => ({
    pattern,
    target: path.resolve(APP, targets[0])
  }))
}

// --------------------------------------------------------------------------
// Filesystem, cached
// --------------------------------------------------------------------------

const statCache = new Map(without.map(file => [file, null]))
function stat(abs) {
  if (!statCache.has(abs)) {
    let kind = null
    try {
      const s = fs.statSync(abs)
      kind = s.isFile() ? 'file' : s.isDirectory() ? 'dir' : null
    } catch {
      kind = null
    }
    statCache.set(abs, kind)
  }
  return statCache.get(abs)
}
const isFile = abs => stat(abs) === 'file'
const isDir = abs => stat(abs) === 'dir'

const jsonCache = new Map()
function readJson(abs) {
  if (!jsonCache.has(abs)) {
    let value = null
    try {
      value = JSON.parse(fs.readFileSync(abs, 'utf8'))
    } catch {
      value = null
    }
    jsonCache.set(abs, value)
  }
  return jsonCache.get(abs)
}

// --------------------------------------------------------------------------
// Resolution
// --------------------------------------------------------------------------

const CODE = /\.(?:[cm]?[jt]s|[jt]sx)$/
const TS_OUTPUT = [
  [/\.js$/, ['.ts', '.tsx']],
  [/\.jsx$/, ['.tsx']],
  [/\.mjs$/, ['.mts']],
  [/\.cjs$/, ['.cts']]
]
const BUILTINS = new Set(builtinModules)

let resolveOptions
let tsPaths

/** A path with no query: the file, the file plus an extension, or a directory's entry. */
function resolvePath(base) {
  if (isFile(base)) return base
  for (const ext of resolveOptions.extensions) if (isFile(base + ext)) return base + ext
  for (const [from, tos] of TS_OUTPUT) {
    if (!from.test(base)) continue
    for (const to of tos) if (isFile(base.replace(from, to))) return base.replace(from, to)
  }
  if (isDir(base)) {
    const pkg = readJson(path.join(base, 'package.json'))
    if (pkg) {
      const entry = packageEntry(base, pkg, '.')
      if (entry) return entry
    }
    for (const ext of resolveOptions.extensions) {
      if (isFile(path.join(base, 'index' + ext))) return path.join(base, 'index' + ext)
    }
  }
  return null
}

/** One `exports` target — a string, a fallback array, or a conditions object. */
function exportsTarget(target, star) {
  if (typeof target === 'string') return star === undefined ? target : target.replaceAll('*', star)
  if (Array.isArray(target)) {
    for (const item of target) {
      const hit = exportsTarget(item, star)
      if (hit) return hit
    }
    return null
  }
  if (target && typeof target === 'object') {
    for (const [condition, value] of Object.entries(target)) {
      if (!resolveOptions.conditions.has(condition)) continue
      const hit = exportsTarget(value, star)
      if (hit) return hit
    }
  }
  return null
}

/** A package's file for `subpath` (`.` or `./x`), through `exports` or the legacy main fields. */
function packageEntry(dir, pkg, subpath) {
  if (pkg.exports !== undefined && pkg.exports !== null) {
    const exportsField = pkg.exports
    const isMap =
      typeof exportsField === 'object' &&
      !Array.isArray(exportsField) &&
      Object.keys(exportsField).some(key => key.startsWith('.'))
    const map = isMap ? exportsField : { '.': exportsField }
    let target = null
    if (subpath in map) target = exportsTarget(map[subpath])
    else {
      const patterns = Object.keys(map)
        .filter(key => key.includes('*'))
        .sort((a, b) => b.indexOf('*') - a.indexOf('*') || byString(a, b))
      for (const key of patterns) {
        const [head, tail] = key.split('*')
        if (subpath.startsWith(head) && subpath.endsWith(tail) && subpath.length >= key.length - 1) {
          target = exportsTarget(map[key], subpath.slice(head.length, subpath.length - tail.length))
          if (target) break
        }
      }
    }
    if (!target) return null
    const abs = path.join(dir, target)
    return isFile(abs) ? abs : null
  }
  if (subpath !== '.') return resolvePath(path.join(dir, subpath))
  for (const field of ['browser', 'module', 'jsnext:main', 'main']) {
    if (typeof pkg[field] !== 'string') continue
    const hit = resolvePath(path.join(dir, pkg[field]))
    if (hit) return hit
  }
  return resolvePath(path.join(dir, 'index'))
}

/** A bare specifier, by walking up `node_modules` from the importer. */
function resolveBare(specifier, importer) {
  const parts = specifier.split('/')
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
  const subpath = specifier.length > name.length ? '.' + specifier.slice(name.length) : '.'
  for (let dir = path.dirname(importer); ; dir = path.dirname(dir)) {
    const pkgDir = path.join(dir, 'node_modules', name)
    if (isDir(pkgDir)) {
      const pkg = readJson(path.join(pkgDir, 'package.json'))
      // A directory with no manifest is a nested subpath package; probe it as a path.
      const entry = pkg ? packageEntry(pkgDir, pkg, subpath) : null
      return entry ?? resolvePath(path.join(pkgDir, subpath))
    }
    if (dir === path.dirname(dir)) return null
  }
}

function applyAlias(specifier) {
  for (const { find, replacement } of resolveOptions.alias) {
    if (find instanceof RegExp) {
      if (find.test(specifier)) return specifier.replace(find, replacement)
    } else if (specifier === find || specifier.startsWith(find + '/')) {
      return replacement + specifier.slice(find.length)
    }
  }
  return null
}

const QUERY_LEAF = /(?:^|&)(?:raw|url|inline|no-inline)(?:&|=|$)/
const QUERY_WORKER = /(?:^|&)(?:worker|sharedworker)(?:&|=|$)/

/**
 * @returns {{ file: string | null, leaf: boolean, note?: string }}
 *   `file` null = the bundler cannot find it; `leaf` = loaded, never parsed for names.
 */
function resolve(specifier, importer) {
  const aliased = applyAlias(specifier)
  const spec = aliased ?? specifier
  const q = spec.indexOf('?')
  const bare = q === -1 ? spec : spec.slice(0, q)
  const query = q === -1 ? '' : spec.slice(q + 1)
  const leaf = QUERY_LEAF.test(query) && !QUERY_WORKER.test(query)

  if (/^(?:node:|data:|https?:|virtual:|\0)/.test(bare)) return { file: bare, leaf: true, note: 'builtin' }

  let file
  if (path.isAbsolute(bare)) {
    // An alias target is a real path; a root-relative specifier is relative to the app.
    file = resolvePath(bare) ?? (aliased === null ? resolvePath(path.join(APP, bare)) : null)
  } else if (bare.startsWith('./') || bare.startsWith('../') || bare === '.' || bare === '..') {
    file = resolvePath(path.resolve(path.dirname(importer), bare))
  } else if (BUILTINS.has(bare.split('/')[0]) && !resolveBare(bare, importer)) {
    return { file: bare, leaf: true, note: 'builtin' }
  } else {
    file = resolveBare(bare, importer)
  }

  if (!file && aliased === null) {
    for (const { pattern, target } of tsPaths) {
      const hit = pattern.endsWith('/*')
        ? bare.startsWith(pattern.slice(0, -1)) && resolvePath(target.slice(0, -1) + bare.slice(pattern.length - 1))
        : bare === pattern && resolvePath(target)
      if (hit) return { file: null, leaf, note: `tsconfig paths only -> ${rel(hit)}` }
    }
  }
  return { file: file ?? null, leaf: leaf || (file !== null && file !== undefined && !CODE.test(file)) }
}

// --------------------------------------------------------------------------
// Parsing one module
// --------------------------------------------------------------------------

const hasModifier = (node, kind) => !!node.modifiers?.some(m => m.kind === kind)

/** Does this namespace body hold anything that survives the transform? */
function namespaceHasValues(node) {
  let body = node.body
  while (body && ts.isModuleDeclaration(body)) body = body.body
  if (!body || !ts.isModuleBlock(body)) return false
  return body.statements.some(s => !ts.isInterfaceDeclaration(s) && !ts.isTypeAliasDeclaration(s))
}

function bindingNames(name, out) {
  if (ts.isIdentifier(name)) out.push(name.text)
  else for (const element of name.elements) if (!ts.isOmittedExpression(element)) bindingNames(element.name, out)
}

function scriptKind(file) {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX
  if (/\.[cm]?ts$/.test(file)) return ts.ScriptKind.TS
  return ts.ScriptKind.JS
}

/**
 * @typedef {{ imported: string, local: string, line: number }} Binding
 * @typedef {{ specifier: string, kind: 'static'|'reexport'|'star'|'dynamic'|'glob'|'url', names: Binding[], line: number }} Request
 */

function parseModule(file) {
  const text = fs.readFileSync(file, 'utf8')
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file))
  const lineOf = node => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1

  /** @type {Request[]} */
  const requests = []
  const values = new Set() // names the module exports as values
  const localValues = new Set() // top-level value declarations
  const localTypes = new Set() // top-level type-only declarations
  const importLocals = new Map() // local -> { request, binding }
  const namespaceLocals = new Map() // local -> request
  const localExports = [] // [local, exported] from `export { a as b }`
  const stars = [] // specifiers of `export * from`
  const forwards = new Map() // exported name -> { specifier, imported }: names that live elsewhere
  let esm = false

  for (const node of sf.statements) {
    if (ts.isImportDeclaration(node)) {
      esm = true
      if (!ts.isStringLiteral(node.moduleSpecifier)) continue
      const request = { specifier: node.moduleSpecifier.text, kind: 'static', names: [], line: lineOf(node) }
      const clause = node.importClause
      if (!clause) {
        request.sideEffect = true
        requests.push(request)
        continue
      }
      if (clause.isTypeOnly) continue
      request.candidates = []
      if (clause.name) request.candidates.push({ imported: 'default', local: clause.name.text, line: lineOf(clause) })
      const named = clause.namedBindings
      if (named && ts.isNamespaceImport(named)) {
        request.namespace = named.name.text
        namespaceLocals.set(named.name.text, request)
      } else if (named) {
        for (const el of named.elements) {
          if (el.isTypeOnly) continue
          request.candidates.push({
            imported: (el.propertyName ?? el.name).text,
            local: el.name.text,
            line: lineOf(el)
          })
        }
      }
      for (const binding of request.candidates) importLocals.set(binding.local, { request, binding })
      requests.push(request)
      continue
    }

    if (ts.isExportDeclaration(node)) {
      esm = true
      if (node.isTypeOnly) continue
      const from = node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : null
      if (!node.exportClause) {
        if (from) {
          stars.push(from)
          requests.push({ specifier: from, kind: 'star', names: [], line: lineOf(node) })
        }
      } else if (ts.isNamespaceExport(node.exportClause)) {
        values.add(node.exportClause.name.text)
        if (from) requests.push({ specifier: from, kind: 'star', names: [], line: lineOf(node) })
      } else {
        const elements = node.exportClause.elements.filter(el => !el.isTypeOnly)
        if (from) {
          if (!elements.length) continue
          requests.push({
            specifier: from,
            kind: 'reexport',
            names: elements.map(el => ({
              imported: (el.propertyName ?? el.name).text,
              local: el.name.text,
              line: lineOf(el)
            })),
            line: lineOf(node)
          })
          for (const el of elements) {
            forwards.set(el.name.text, { specifier: from, imported: (el.propertyName ?? el.name).text })
          }
        } else {
          for (const el of elements) localExports.push([(el.propertyName ?? el.name).text, el.name.text])
        }
      }
      continue
    }

    if (ts.isExportAssignment(node)) {
      esm = true
      if (!node.isExportEquals) values.add('default')
      continue
    }

    // Declarations — top-level names, and the exported ones among them.
    const declared = hasModifier(node, ts.SyntaxKind.DeclareKeyword)
    const exported = hasModifier(node, ts.SyntaxKind.ExportKeyword)
    const isDefault = hasModifier(node, ts.SyntaxKind.DefaultKeyword)
    if (exported) esm = true
    const names = []
    let isValue = !declared
    if (ts.isVariableStatement(node)) for (const d of node.declarationList.declarations) bindingNames(d.name, names)
    else if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isEnumDeclaration(node)) {
      if (node.name) names.push(node.name.text)
    } else if (ts.isModuleDeclaration(node)) {
      if (ts.isIdentifier(node.name)) names.push(node.name.text)
      isValue = isValue && namespaceHasValues(node)
    } else if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
      names.push(node.name.text)
      isValue = false
    } else if (ts.isImportEqualsDeclaration(node)) {
      names.push(node.name.text)
    } else continue

    for (const name of names) (isValue ? localValues : localTypes).add(name)
    if (exported && isValue) {
      if (isDefault) values.add('default')
      else for (const name of names) values.add(name)
    }
  }

  // `export { a as b }` — a value if `a` is one here or arrives through an import.
  for (const [local, exportedAs] of localExports) {
    const imported = importLocals.get(local)
    if (imported && !localValues.has(local)) {
      forwards.set(exportedAs, { specifier: imported.request.specifier, imported: imported.binding.imported })
    } else if (localValues.has(local) || namespaceLocals.has(local) || !localTypes.has(local)) values.add(exportedAs)
  }

  // One walk: which import bindings are read as values, what is read off each
  // namespace import, and every request that is an expression rather than a statement.
  const used = new Set(localExports.map(([local]) => local))
  const namespaceReads = new Map()
  const dynamicUnknown = []

  const literal = node =>
    node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null
  const isImportMeta = node =>
    ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword && node.name.text === 'meta'

  const visit = node => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return
    if (hasModifier(node, ts.SyntaxKind.DeclareKeyword)) return
    if (ts.isHeritageClause(node)) {
      if (node.token === ts.SyntaxKind.ExtendsKeyword) for (const type of node.types) visit(type.expression)
      return
    }
    if (ts.isTypeNode(node)) return

    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const specifier = literal(node.arguments[0])
        if (specifier === null) dynamicUnknown.push(lineOf(node))
        else requests.push({ specifier, kind: 'dynamic', names: [], line: lineOf(node) })
      } else if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'glob' &&
        isImportMeta(node.expression.expression)
      ) {
        const first = node.arguments[0]
        const patterns = first && ts.isArrayLiteralExpression(first) ? first.elements.map(literal) : [literal(first)]
        const options = node.arguments[1]
        let query = ''
        if (options && ts.isObjectLiteralExpression(options)) {
          for (const prop of options.properties) {
            if (ts.isPropertyAssignment(prop) && prop.name.getText(sf) === 'query')
              query = literal(prop.initializer) ?? ''
          }
        }
        requests.push({
          specifier: patterns.filter(p => p !== null).join(','),
          kind: 'glob',
          names: [],
          line: lineOf(node),
          patterns: patterns.filter(p => p !== null),
          query
        })
      }
    } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL') {
      const [target, base] = node.arguments ?? []
      const specifier = literal(target)
      if (specifier !== null && base && ts.isPropertyAccessExpression(base) && isImportMeta(base.expression)) {
        if (/^\.{0,2}\//.test(specifier)) requests.push({ specifier, kind: 'url', names: [], line: lineOf(node) })
      }
    }

    if (ts.isIdentifier(node)) {
      const parent = node.parent
      const text = node.text
      if (importLocals.has(text) || namespaceLocals.has(text)) {
        const isName = parent && parent.name === node && !ts.isShorthandPropertyAssignment(parent)
        const isPropertyName = parent && ts.isBindingElement(parent) && parent.propertyName === node
        const isLabel =
          parent && (ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)) && parent.label === node
        const isIntrinsicTag =
          parent &&
          (ts.isJsxOpeningElement(parent) || ts.isJsxSelfClosingElement(parent) || ts.isJsxClosingElement(parent)) &&
          parent.tagName === node &&
          /^[a-z]/.test(text)
        if (!isName && !isPropertyName && !isLabel && !isIntrinsicTag) {
          used.add(text)
          if (namespaceLocals.has(text) && ts.isPropertyAccessExpression(parent) && parent.expression === node) {
            if (!namespaceReads.has(text)) namespaceReads.set(text, new Map())
            const reads = namespaceReads.get(text)
            if (!reads.has(parent.name.text)) reads.set(parent.name.text, lineOf(parent))
          }
        }
      }
      return
    }
    ts.forEachChild(node, visit)
  }
  for (const statement of sf.statements) visit(statement)

  // Apply the elision: keep the bindings that are read, drop the import if none are.
  const kept = []
  for (const request of requests) {
    if (request.kind !== 'static' || request.sideEffect) {
      kept.push(request)
      continue
    }
    request.names = request.candidates.filter(binding => used.has(binding.local))
    const namespaceUsed = request.namespace !== undefined && used.has(request.namespace)
    if (namespaceUsed) {
      request.namespaceReads = [...(namespaceReads.get(request.namespace) ?? [])]
        .map(([name, line]) => ({ name, line }))
        .sort((a, b) => byString(a.name, b.name))
    }
    if (request.names.length || namespaceUsed) kept.push(request)
  }

  // CommonJS or UMD: the bundler wraps it with interop, so any name is "there".
  // A file with neither module syntax nor these markers is an empty ES module.
  const commonJs = !esm && /\bmodule\.exports\b|\bexports\.[\w$]+\s*=|\bexports\[|\(exports\b|\brequire\s*\(/.test(text)

  return { file, commonJs, values, stars, forwards, requests: kept, dynamicUnknown }
}

// --------------------------------------------------------------------------
// The graph
// --------------------------------------------------------------------------

const modules = new Map() // abs file -> parsed module, or { open: true }
const isExternal = file => file.includes(`${path.sep}node_modules${path.sep}`)

function load(file) {
  if (!modules.has(file)) {
    let parsed
    try {
      parsed = CODE.test(file) ? parseModule(file) : { file, open: true }
    } catch (error) {
      parsed = { file, open: true, parseError: String(error.message ?? error) }
    }
    if (parsed.commonJs) parsed.open = true
    modules.set(file, parsed)
  }
  return modules.get(file)
}

/**
 * Does `file` provide `name` to an importer, after the transform? A forwarded
 * name is followed to its origin, because the bundler does the same: a name
 * missing at the origin fails at the forwarding module AND at everyone who
 * imports it from there.
 */
function provides(file, name, seen = new Set()) {
  const key = `${file}\0${name}`
  if (seen.has(key)) return false
  seen.add(key)
  const mod = load(file)
  if (mod.open || mod.values.has(name)) return true
  const forward = mod.forwards.get(name)
  if (forward) {
    const target = resolve(forward.specifier, file)
    return !target.file || target.leaf || provides(target.file, forward.imported, seen)
  }
  if (name === 'default') return false
  for (const specifier of mod.stars) {
    const target = resolve(specifier, file)
    // An unresolvable or non-code star target is reported on its own; unknown here.
    if (!target.file || target.leaf) return true
    if (provides(target.file, name, seen)) return true
  }
  return false
}

function expandGlob(request, importer) {
  const include = []
  const exclude = []
  for (const pattern of request.patterns) {
    const negated = pattern.startsWith('!')
    const raw = negated ? pattern.slice(1) : pattern
    const aliased = applyAlias(raw)
    const abs = aliased ?? (raw.startsWith('/') ? path.join(APP, raw) : path.resolve(path.dirname(importer), raw))
    ;(negated ? exclude : include).push(abs)
  }
  const out = new Set()
  for (const pattern of include) {
    for (const hit of fs.globSync(pattern, { exclude: exclude.length ? exclude : undefined })) {
      if (hit !== importer && isFile(hit) && !isExternal(hit)) out.add(hit)
    }
  }
  return [...out].sort(byString)
}

function walk(entries) {
  const edges = [] // missing names
  const unresolved = [] // missing files
  const builtins = []
  const namespaceMisses = []
  const dynamicUnknown = []
  const staticGraph = new Map() // file -> Set<file>, static requests only (cycles)
  const fullGraph = new Map() // file -> Set<file>, everything (reachability)
  const queue = [...entries]
  const seen = new Set(queue)

  const enqueue = (from, to, isStatic) => {
    fullGraph.get(from).add(to)
    if (isStatic) staticGraph.get(from).add(to)
    if (!seen.has(to)) {
      seen.add(to)
      queue.push(to)
    }
  }

  while (queue.length) {
    const file = queue.shift()
    staticGraph.set(file, staticGraph.get(file) ?? new Set())
    fullGraph.set(file, fullGraph.get(file) ?? new Set())
    const mod = load(file)
    if (mod.open) continue
    for (const line of mod.dynamicUnknown) dynamicUnknown.push({ importer: rel(file), line })

    for (const request of mod.requests) {
      if (request.kind === 'glob') {
        const leaf = QUERY_LEAF.test(request.query.replace(/^\?/, ''))
        for (const hit of expandGlob(request, file)) if (!leaf && CODE.test(hit)) enqueue(file, hit, false)
        continue
      }

      const target = resolve(request.specifier, file)
      if (target.note === 'builtin') {
        if (!/^(?:data:|https?:)/.test(request.specifier)) {
          builtins.push({ importer: rel(file), specifier: request.specifier, line: request.line })
        }
        continue
      }
      if (!target.file) {
        // `new URL('./x', import.meta.url)` that matches no file is left as a runtime URL.
        if (request.kind !== 'url') {
          unresolved.push({
            importer: rel(file),
            specifier: request.specifier,
            line: request.line,
            kind: request.kind,
            ...(target.note ? { note: target.note } : {})
          })
        }
        continue
      }
      if (request.kind === 'url' && !CODE.test(target.file)) continue

      const external = isExternal(target.file)
      if (!target.leaf && !external) {
        enqueue(file, target.file, request.kind === 'static' || request.kind === 'reexport' || request.kind === 'star')
      }
      if (target.leaf) continue

      for (const binding of request.names) {
        if (provides(target.file, binding.imported)) continue
        edges.push({
          importer: rel(file),
          provider: rel(target.file),
          symbol: binding.imported,
          line: binding.line,
          kind: request.kind,
          external,
          // The provider only forwards this name; the real gap is further down the chain.
          cascade: !load(target.file).open && load(target.file).forwards.has(binding.imported)
        })
      }
      for (const read of request.namespaceReads ?? []) {
        if (provides(target.file, read.name)) continue
        namespaceMisses.push({ importer: rel(file), provider: rel(target.file), symbol: read.name, line: read.line })
      }
    }
  }

  return { edges, unresolved, builtins, namespaceMisses, dynamicUnknown, staticGraph, fullGraph }
}

// --------------------------------------------------------------------------
// Cycles — strongly connected components of the static graph
// --------------------------------------------------------------------------

function cycles(graph) {
  const index = new Map()
  const low = new Map()
  const onStack = new Set()
  const stack = []
  const out = []
  let counter = 0

  for (const root of [...graph.keys()].sort(byString)) {
    if (index.has(root)) continue
    const work = [[root, [...graph.get(root)].sort(byString), 0]]
    index.set(root, counter)
    low.set(root, counter)
    counter += 1
    stack.push(root)
    onStack.add(root)

    while (work.length) {
      const frame = work[work.length - 1]
      const [node, next] = frame
      if (frame[2] < next.length) {
        const child = next[frame[2]]
        frame[2] += 1
        if (!graph.has(child)) continue
        if (!index.has(child)) {
          index.set(child, counter)
          low.set(child, counter)
          counter += 1
          stack.push(child)
          onStack.add(child)
          work.push([child, [...graph.get(child)].sort(byString), 0])
        } else if (onStack.has(child)) low.set(node, Math.min(low.get(node), index.get(child)))
        continue
      }
      work.pop()
      if (work.length) {
        const parent = work[work.length - 1][0]
        low.set(parent, Math.min(low.get(parent), low.get(node)))
      }
      if (low.get(node) === index.get(node)) {
        const members = []
        let member
        do {
          member = stack.pop()
          onStack.delete(member)
          members.push(member)
        } while (member !== node)
        if (members.length > 1 || graph.get(node).has(node)) out.push(members.map(rel).sort(byString))
      }
    }
  }
  return out.sort((a, b) => b.length - a.length || byString(a[0], b[0]))
}

// --------------------------------------------------------------------------
// The legacy island
// --------------------------------------------------------------------------

function globToRegExp(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*'
        i += 1
        if (glob[i + 1] === '/') i += 1
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

/**
 * The modules the old session fold lives in: the glob that follows each
 * `# LEGACY` comment in `sync/protected.txt`, plus the modules
 * `src/legacy-session-fold.test.ts` holds a ceiling on.
 */
function legacyMatchers() {
  const matchers = []
  try {
    let armed = false
    for (const raw of fs.readFileSync(path.join(SYNC_DIR, 'protected.txt'), 'utf8').split('\n')) {
      const line = raw.trim()
      if (line.startsWith('#')) {
        if (/^#\s*LEGACY\b/.test(line)) armed = true
      } else if (line && armed) {
        matchers.push(globToRegExp(line))
        armed = false
      } else if (!line) armed = false
    }
  } catch {
    // No manifest, no legacy block.
  }
  try {
    const test = fs.readFileSync(path.join(SRC, 'legacy-session-fold.test.ts'), 'utf8')
    const block = test.match(/CEILINGS[^=]*=\s*\{([^}]*)\}/)?.[1] ?? ''
    for (const [, module] of block.matchAll(/['"]([^'"]+)['"]\s*:/g)) matchers.push(globToRegExp(`${module}.*`))
  } catch {
    // No ceiling test.
  }
  return matchers
}

function reachable(entries, graph, removed) {
  const seen = new Set()
  const queue = entries.filter(file => !removed.has(file))
  for (const file of queue) seen.add(file)
  while (queue.length) {
    for (const next of graph.get(queue.shift()) ?? []) {
      if (seen.has(next) || removed.has(next)) continue
      seen.add(next)
      queue.push(next)
    }
  }
  return seen
}

// --------------------------------------------------------------------------
// Report
// --------------------------------------------------------------------------

function rankProviders(edges) {
  const legacyOf = new Map(edges.map(edge => [edge.importer, edge.legacy]))
  const perImporter = new Map()
  for (const edge of edges) {
    if (!perImporter.has(edge.importer)) perImporter.set(edge.importer, new Set())
    perImporter.get(edge.importer).add(edge.provider)
  }
  const providers = new Map()
  for (const edge of edges) {
    if (!providers.has(edge.provider)) providers.set(edge.provider, [])
    providers.get(edge.provider).push(edge)
  }
  return [...providers]
    .map(([provider, list]) => {
      const importers = new Map()
      for (const edge of list) {
        if (!importers.has(edge.importer)) importers.set(edge.importer, new Set())
        importers.get(edge.importer).add(edge.symbol)
      }
      const importerList = [...importers]
        .map(([importer, symbols]) => ({
          importer,
          symbols: [...symbols].sort(byString),
          legacy: legacyOf.get(importer),
          soleBlocker: perImporter.get(importer).size === 1
        }))
        .sort((a, b) => byString(a.importer, b.importer))
      return {
        provider,
        external: list[0].external,
        edges: list.length,
        nonLegacyEdges: list.filter(edge => edge.legacy === null).length,
        symbols: [...new Set(list.map(edge => edge.symbol))].sort(byString),
        unblocks: importerList.filter(item => item.soleBlocker).length,
        importers: importerList
      }
    })
    .sort((a, b) => b.unblocks - a.unblocks || b.edges - a.edges || byString(a.provider, b.provider))
}

function summarise(edges) {
  return {
    edges: edges.length,
    pairs: new Set(edges.map(edge => `${edge.provider}\0${edge.symbol}`)).size,
    providers: new Set(edges.map(edge => edge.provider)).size,
    blockedImporters: new Set(edges.map(edge => edge.importer)).size
  }
}

const summaryLine = s =>
  `edges ${s.edges}, pairs ${s.pairs}, providers ${s.providers}, blocked importers ${s.blockedImporters}`

async function main() {
  resolveOptions = await bundlerResolveOptions()
  tsPaths = tsconfigPaths()

  const entryOption = option('--entry')
  const entries = entryOption ? [path.resolve(APP, entryOption)] : htmlEntries()
  if (!entries.length) entries.push(path.join(SRC, 'main.tsx'))

  const result = walk(entries)

  // One edge per (importer, provider, symbol); the bundler repeats an error per
  // import statement, so `occurrences` is the number it prints.
  const occurrences = result.edges.length
  const distinct = new Map()
  for (const edge of result.edges) {
    const key = `${edge.importer}\0${edge.provider}\0${edge.symbol}`
    if (!distinct.has(key)) distinct.set(key, edge)
  }
  const edges = [...distinct.values()].sort(
    (a, b) => byString(a.provider, b.provider) || byString(a.symbol, b.symbol) || byString(a.importer, b.importer)
  )

  // Legacy: the modules, their direct importers (the island), and what only they reach.
  const matchers = legacyMatchers()
  const isLegacy = file => {
    const inSrc = path.relative(SRC, file).split(path.sep).join('/')
    return !inSrc.startsWith('..') && matchers.some(re => re.test(inSrc))
  }
  const legacyModules = new Set([...result.fullGraph.keys()].filter(isLegacy))
  const island = new Set(legacyModules)
  for (const [file, targets] of result.fullGraph) {
    for (const target of targets) if (legacyModules.has(target)) island.add(file)
  }
  const liveWithoutModules = reachable(entries, result.fullGraph, legacyModules)
  const liveWithoutIsland = reachable(entries, result.fullGraph, island)
  for (const edge of edges) {
    const importer = path.resolve(APP, edge.importer)
    edge.legacy = legacyModules.has(importer)
      ? 'module'
      : island.has(importer)
        ? 'island'
        : !liveWithoutModules.has(importer)
          ? 'only-via-modules'
          : !liveWithoutIsland.has(importer)
            ? 'only-via-island'
            : null
  }

  const live = edges.filter(edge => edge.legacy === null)
  const report = {
    entry: entries.map(rel),
    mode: serve ? 'serve' : 'build',
    without: without.map(rel),
    modules: result.fullGraph.size,
    // Every module the walk reached, for before/after reachability diffs.
    moduleList: [...result.fullGraph.keys()].map(rel).sort(byString),
    summary: summarise(edges),
    occurrences,
    nonLegacy: summarise(live),
    legacy: {
      modules: [...legacyModules].map(rel).sort(byString),
      island: [...island].map(rel).sort(byString),
      edgesByTag: Object.fromEntries(
        ['module', 'island', 'only-via-modules', 'only-via-island'].map(tag => [
          tag,
          edges.filter(edge => edge.legacy === tag).length
        ])
      )
    },
    providers: rankProviders(edges),
    unresolved: result.unresolved.sort(
      (a, b) => byString(a.specifier, b.specifier) || byString(a.importer, b.importer) || a.line - b.line
    ),
    builtins: result.builtins.sort((a, b) => byString(a.specifier, b.specifier) || byString(a.importer, b.importer)),
    namespaceMisses: result.namespaceMisses.sort(
      (a, b) => byString(a.provider, b.provider) || byString(a.symbol, b.symbol) || byString(a.importer, b.importer)
    ),
    dynamicUnknown: result.dynamicUnknown.sort((a, b) => byString(a.importer, b.importer) || a.line - b.line),
    cycles: cycles(result.staticGraph).map(members => ({ size: members.length, members })),
    edges
  }

  if (asJson) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  } else if (providerFilter) {
    const wanted = rel(path.resolve(APP, providerFilter))
    const hit = report.providers.find(p => p.provider === wanted || p.provider === providerFilter)
    if (!hit) console.log(`${wanted}: no missing exports`)
    else {
      console.log(`${hit.provider}: ${hit.edges} edges, ${hit.symbols.length} symbols, unblocks ${hit.unblocks} files`)
      for (const symbol of hit.symbols) {
        console.log(`  ${symbol}`)
        for (const edge of edges.filter(e => e.provider === hit.provider && e.symbol === symbol)) {
          console.log(`    ${edge.importer}:${edge.line}${edge.legacy ? `  [legacy: ${edge.legacy}]` : ''}`)
        }
      }
    }
  } else {
    console.log(`link-edges: ${report.entry.join(', ')} (${report.mode} aliases), ${report.modules} modules reachable`)
    console.log(summaryLine(report.summary))
    console.log(`non-legacy: ${summaryLine(report.nonLegacy)}`)
    console.log(
      `legacy: ${Object.entries(report.legacy.edgesByTag)
        .map(([tag, n]) => `${tag} ${n}`)
        .join(', ')} (${report.legacy.modules.length} modules, ${report.legacy.island.length} island files)`
    )
    console.log(
      `bundler error count ${occurrences}; unresolved specifiers ${report.unresolved.length}; ` +
        `namespace reads of missing names ${report.namespaceMisses.length}; cycles ${report.cycles.length}`
    )

    console.log('\nPROVIDERS — ranked by importer files fully unblocked, then edges')
    console.log('  #  unblocks  edges  symbols  importers  provider')
    report.providers.slice(0, top).forEach((p, i) => {
      const cells = [i + 1, p.unblocks, p.edges, p.symbols.length, p.importers.length].map((n, col) =>
        String(n).padStart([3, 9, 6, 8, 10][col])
      )
      console.log(`${cells.join(' ')}  ${p.provider}${p.external ? '  [external]' : ''}`)
      console.log(`       missing: ${p.symbols.join(', ')}`)
      for (const item of p.importers) {
        const tag = item.legacy ? `  [legacy: ${item.legacy}]` : ''
        console.log(`       ${item.soleBlocker ? '*' : ' '} ${item.importer} (${item.symbols.join(', ')})${tag}`)
      }
    })
    console.log('       (* = this provider is the only thing blocking that file)')

    console.log(`\nUNRESOLVED SPECIFIERS — ${report.unresolved.length}`)
    for (const u of report.unresolved) {
      console.log(`  ${u.specifier}  <- ${u.importer}:${u.line} [${u.kind}]${u.note ? `  (${u.note})` : ''}`)
    }
    if (report.builtins.length) {
      console.log(`\nNODE BUILTINS IN THE BROWSER GRAPH — ${report.builtins.length}`)
      for (const b of report.builtins) console.log(`  ${b.specifier}  <- ${b.importer}:${b.line}`)
    }
    if (report.namespaceMisses.length) {
      console.log(
        `\nNAMESPACE READS OF MISSING NAMES (bundler warns, value is undefined) — ${report.namespaceMisses.length}`
      )
      for (const n of report.namespaceMisses) console.log(`  ${n.provider}#${n.symbol}  <- ${n.importer}:${n.line}`)
    }
    console.log(`\nIMPORT CYCLES (static graph) — ${report.cycles.length}`)
    for (const cycle of report.cycles) {
      console.log(`  ${cycle.size} modules: ${cycle.members.slice(0, 6).join(', ')}${cycle.size > 6 ? ', …' : ''}`)
    }
  }

  if (maxEdges !== undefined && report.summary.edges > maxEdges) {
    console.error(`link-edges: ${report.summary.edges} edges exceeds --max-edges ${maxEdges}`)
    process.exitCode = 1
  }
}

await main()
