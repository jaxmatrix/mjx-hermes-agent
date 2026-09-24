#!/usr/bin/env node
/**
 * Safe import repoint for post-absorb reconciliation.
 *
 * Reads tsc-style misses (importer imports `symbol` from `module`, but module
 * does not export it). If exactly one file under src/ still exports that
 * symbol name, rewrite the import specifier to that file.
 *
 *   node scripts/repoint-imports.mjs --dry     # print plan
 *   node scripts/repoint-imports.mjs --apply   # write files
 *   node scripts/repoint-imports.mjs --from /tmp/tsc-misses.tsv
 *
 * Miss TSV columns: importerPath \t moduleSpecifier \t symbol
 * If --from is omitted, runs `tsc -p . --noEmit` and parses stderr.
 *
 * Does NOT invent symbols, copy archive bodies, or rewrite renames
 * (SessionResumeResponse → SessionResumeResult). Those stay manual.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const APP = path.resolve(here, '..')
const SRC = path.join(APP, 'src')

const apply = process.argv.includes('--apply')
const dry = process.argv.includes('--dry') || !apply
const fromIdx = process.argv.indexOf('--from')
const fromPath = fromIdx >= 0 ? process.argv[fromIdx + 1] : null

const EXPORT_RE = /^export\s+(?:async\s+)?(?:const|let|var|function|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/gm
const EXPORT_LIST_RE = /^export\s+(?:type\s+)?\{([^}]+)\}/gm

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) walk(p, out)
    else if (/\.tsx?$/.test(ent.name) && !ent.name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

function exportedNames(file) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    const names = new Set([...text.matchAll(EXPORT_RE)].map(m => m[1]))
    for (const m of text.matchAll(EXPORT_LIST_RE)) {
      for (const part of m[1].split(',')) {
        const raw = part.trim()
        if (!raw) continue
        const bits = raw.split(/\s+as\s+/)
        names.add(bits[bits.length - 1].trim())
      }
    }
    return names
  } catch {
    return new Set()
  }
}

/** Map symbol → absolute file paths that export it. */
function buildExportIndex() {
  const index = new Map()
  for (const file of walk(SRC)) {
    for (const name of exportedNames(file)) {
      if (!index.has(name)) index.set(name, [])
      index.get(name).push(file)
    }
  }
  return index
}

function parseTscOutput(text) {
  const misses = []
  for (const line of text.split(/\r?\n/)) {
    let m = line.match(
      /^(.+?)\(\d+,\d+\): error TS(?:2305|2724): Module '"([^"]+)"' has no exported member (?:named )?'?([^'".]+)'?/
    )
    if (!m) {
      m = line.match(
        /^(.+?)\(\d+,\d+\): error TS(?:2305|2724): Module '(\.\.?\/[^']+)' has no exported member (?:named )?'?([^'".]+)'?/
      )
    }
    if (!m) continue
    misses.push({ importer: m[1], specifier: m[2], symbol: m[3].replace(/'$/, '') })
  }
  return misses
}

function loadMisses() {
  if (fromPath) {
    const text = fs.readFileSync(fromPath, 'utf8')
    return text
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line => {
        const [importer, specifier, symbol] = line.split('\t')
        return { importer, specifier, symbol }
      })
  }
  let out = ''
  try {
    execFileSync('npx', ['tsc', '-p', '.', '--noEmit', '--pretty', 'false'], {
      cwd: APP,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (err) {
    out = `${err.stdout || ''}${err.stderr || ''}`
  }
  return parseTscOutput(out)
}

function resolveImporter(relOrAbs) {
  return path.isAbsolute(relOrAbs) ? relOrAbs : path.join(APP, relOrAbs)
}

function resolveProviderFile(importerAbs, specifier) {
  if (specifier.startsWith('@/')) {
    const base = path.join(SRC, specifier.slice(2))
    for (const c of [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
      if (fs.existsSync(c)) return c
    }
    return `${base}.ts`
  }
  if (specifier.startsWith('.')) {
    const base = path.resolve(path.dirname(importerAbs), specifier)
    for (const c of [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
      if (fs.existsSync(c)) return c
    }
    return `${base}.ts`
  }
  return null // package import — skip
}

function toAtImport(absFile) {
  let rel = path.relative(SRC, absFile).replace(/\\/g, '/')
  rel = rel.replace(/\.tsx?$/, '')
  rel = rel.replace(/\/index$/, '')
  return `@/${rel}`
}

/**
 * Rewrite named imports of `symbol` that use `oldSpec` to `newSpec` in file text.
 * Handles `import { … symbol … } from 'old'` and `import type { … }`.
 */
function rewriteImports(text, symbol, oldSpec, newSpec) {
  let changed = 0
  // Match import / import type blocks from oldSpec
  const re = new RegExp(`(import\\s+(type\\s+)?\\{)([^}]*)(\\}\\s*from\\s*)(['"])${escapeReg(oldSpec)}\\5`, 'g')
  const next = text.replace(re, (full, head, typeKw, body, mid, quote) => {
    const parts = body
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
    const has = parts.some(p => {
      const local = p
        .split(/\s+as\s+/)
        .pop()
        .trim()
      return local === symbol || p.startsWith(`${symbol} `) || p === symbol
    })
    if (!has) return full

    // If this import only had this symbol (and maybe type), retarget whole clause.
    // If mixed with other bindings still from oldSpec, split: keep others on old, move symbol to new.
    const keep = []
    const move = []
    for (const p of parts) {
      const local = p
        .split(/\s+as\s+/)
        .pop()
        .trim()
      const base = p.split(/\s+as\s+/)[0].trim()
      if (local === symbol || base === symbol) move.push(p)
      else keep.push(p)
    }
    if (!move.length) return full
    changed += 1
    const typePrefix = typeKw || ''
    if (!keep.length) {
      return `import ${typePrefix}{ ${move.join(', ')} } from ${quote}${newSpec}${quote}`
    }
    return (
      `import ${typePrefix}{ ${keep.join(', ')} } from ${quote}${oldSpec}${quote};\n` +
      `import ${typePrefix}{ ${move.join(', ')} } from ${quote}${newSpec}${quote}`
    )
  })
  return { text: next, changed }
}

function escapeReg(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const index = buildExportIndex()
const misses = loadMisses()

const plans = []
const skipped = { package: 0, zero: 0, many: 0, already: 0, sameModule: 0 }

const seen = new Set()
for (const miss of misses) {
  const key = `${miss.importer}\t${miss.specifier}\t${miss.symbol}`
  if (seen.has(key)) continue
  seen.add(key)

  const importerAbs = resolveImporter(miss.importer)
  if (miss.specifier.startsWith('@hermes/') || (!miss.specifier.startsWith('@/') && !miss.specifier.startsWith('.'))) {
    skipped.package += 1
    continue
  }

  const providers = (index.get(miss.symbol) || []).filter(f => fs.existsSync(f))
  const oldProvider = resolveProviderFile(importerAbs, miss.specifier)
  // Never treat the importer (or a broken re-export barrel that is the importer)
  // as the new home — e.g. chat.ts `export { $approval }` while still importing it.
  const others = providers.filter(
    f => path.resolve(f) !== path.resolve(oldProvider || '') && path.resolve(f) !== path.resolve(importerAbs)
  )

  if (others.length === 0) {
    skipped.zero += 1
    continue
  }
  if (others.length > 1) {
    skipped.many += 1
    continue
  }

  const target = others[0]
  const newSpec = toAtImport(target)
  if (
    newSpec === miss.specifier ||
    (miss.specifier.startsWith('@/') && newSpec === miss.specifier.replace(/\/index$/, ''))
  ) {
    // Same logical module
    if (path.resolve(target) === path.resolve(oldProvider || '')) {
      skipped.sameModule += 1
      continue
    }
  }
  if (newSpec === miss.specifier) {
    skipped.already += 1
    continue
  }

  plans.push({
    importer: path.relative(APP, importerAbs),
    symbol: miss.symbol,
    oldSpec: miss.specifier,
    newSpec,
    target: path.relative(APP, target)
  })
}

console.log(`repoint-imports: ${plans.length} safe rewrites, misses=${seen.size}`)
console.log(
  `skipped: package=${skipped.package} zero=${skipped.zero} many=${skipped.many} sameModule=${skipped.sameModule} already=${skipped.already}`
)

for (const p of plans) {
  console.log(`  ${p.importer}: ${p.symbol}  ${p.oldSpec} → ${p.newSpec}`)
}

if (dry) {
  console.log(apply ? '' : '\ndry run — pass --apply to write files')
  process.exit(0)
}

let filesTouched = 0
let rewriteCount = 0
const byFile = new Map()
for (const p of plans) {
  if (!byFile.has(p.importer)) byFile.set(p.importer, [])
  byFile.get(p.importer).push(p)
}

for (const [rel, list] of byFile) {
  const abs = path.join(APP, rel)
  let text = fs.readFileSync(abs, 'utf8')
  let fileChanged = false
  for (const p of list) {
    const r = rewriteImports(text, p.symbol, p.oldSpec, p.newSpec)
    if (r.changed) {
      text = r.text
      rewriteCount += r.changed
      fileChanged = true
    }
  }
  if (fileChanged) {
    fs.writeFileSync(abs, text)
    filesTouched += 1
  }
}

console.log(`applied: ${rewriteCount} import clauses in ${filesTouched} files`)
