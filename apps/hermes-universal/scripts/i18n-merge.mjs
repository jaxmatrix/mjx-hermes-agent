#!/usr/bin/env node
/**
 * Union a desktop translation catalogue with universal's, in place.
 *
 * The two apps' catalogues diverged in both directions: desktop has surfaces
 * universal lacks, and universal has whole sections desktop has never had —
 * the mobile shell, the browser pane, the tray, downloads, the connection
 * banner. Neither side can simply win, so `src/i18n/*` stays a MERGE file.
 *
 * Doing the union by hand is not realistic (about 4500 keys across six
 * catalogues), and regenerating each file from a parsed tree would reformat
 * everything and bury the real change in churn. So this does the smallest
 * thing that works: it takes DESKTOP's file as the base and splices in, at the
 * end of the matching block, every key universal has and desktop does not,
 * copied verbatim from universal's source. Desktop's formatting, ordering and
 * comments survive untouched, and the diff is exactly the keys that were added.
 *
 * Parsing goes through the TypeScript compiler rather than line matching. A
 * catalogue value can be a multi-line arrow function, and `foo: (n) => {` ends
 * in a brace that no line-based scanner can tell from a nested section — which
 * silently desynchronises the key paths and drops two thirds of the file.
 *
 *   node scripts/i18n-merge.mjs <desktop-file> <universal-file> [--write]
 *
 * Without --write it reports what it would add and changes nothing.
 */

import fs from 'node:fs'
import { createRequire } from 'node:module'

const ts = createRequire(import.meta.url)('typescript')

/**
 * Every key path in a catalogue's exported object literal, with the source
 * span that defines it. A section's span covers its whole block, so splicing
 * one in carries its descendants with it.
 */
function parse(file) {
  const text = fs.readFileSync(file, 'utf8')
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS)

  // Three shapes occur: `export const en: Translations = { … }`, a partial
  // locale wrapped as `export const ja = defineLocale({ … })`, and the
  // `export interface Translations { … }` that all of them satisfy.
  let root = null
  for (const st of sf.statements) {
    if (ts.isInterfaceDeclaration(st)) {
      root = st
      continue
    }
    if (!ts.isVariableStatement(st)) continue
    for (const decl of st.declarationList.declarations) {
      const init = decl.initializer
      if (!init) continue
      if (ts.isObjectLiteralExpression(init)) root = init
      else if (ts.isCallExpression(init) && init.arguments.length && ts.isObjectLiteralExpression(init.arguments[0])) {
        root = init.arguments[0]
      }
    }
  }
  if (!root) throw new Error(`no catalogue object or interface in ${file}`)

  const nodes = new Map()
  const visit = (obj, prefix) => {
    for (const prop of obj.members ?? obj.properties) {
      // A catalogue uses PropertyAssignment; the interface uses PropertySignature.
      const isSig = ts.isPropertySignature(prop)
      if (!isSig && !ts.isPropertyAssignment(prop)) continue
      const name = prop.name
      const key = ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : null
      if (key === null) continue
      const path = prefix ? `${prefix}.${key}` : key
      const value = isSig ? prop.type : prop.initializer
      if (!value) continue
      const section = isSig ? ts.isTypeLiteralNode(value) : ts.isObjectLiteralExpression(value)
      nodes.set(path, {
        section,
        // getStart(sf) skips leading trivia; getFullStart() keeps the comments
        // and blank line above, which is what we want to carry across.
        start: prop.getStart(sf),
        end: prop.getEnd(),
        // Where a section's own children end, i.e. just inside its `}`.
        inner: section ? value.getEnd() - 1 : null,
        indent: prop.getStart(sf) - text.lastIndexOf('\n', prop.getStart(sf)) - 1
      })
      if (section) visit(value, path)
    }
  }
  visit(root, '')
  return { text, nodes, rootInner: root.getEnd() - 1 }
}

const [desktopFile, universalFile] = process.argv.slice(2)
const write = process.argv.includes('--write')
if (!desktopFile || !universalFile) {
  console.error('usage: i18n-merge.mjs <desktop-file> <universal-file> [--write]')
  process.exit(2)
}

const SEP = desktopFile.endsWith('types.ts') ? '' : ','
const d = parse(desktopFile)
const u = parse(universalFile)

// Universal-only keys whose parent desktop DOES have. A key whose parent is
// itself universal-only rides along inside its parent's block, so inserting it
// separately would duplicate it.
const missing = [...u.nodes.keys()].filter(k => !d.nodes.has(k))
// A key can only be spliced into a desktop parent that is actually a block.
// Where universal has a section and desktop has a plain string under the same
// name, there is no place to put it and no safe automatic answer — the two
// apps modelled that key differently. Collect those and refuse, rather than
// splice at a null offset (which silently prepends the block to the file).
const shapeConflicts = []
const toInsert = missing.filter(k => {
  const parent = k.split('.').slice(0, -1).join('.')
  if (parent === '') return true
  const p = d.nodes.get(parent)
  if (!p) return false
  if (!p.section) {
    shapeConflicts.push(`${parent} is a section in universal but a leaf in desktop (blocks ${k})`)
    return false
  }
  return true
})

console.log(desktopFile)
console.log(`  desktop keys      ${d.nodes.size}`)
console.log(`  universal keys    ${u.nodes.size}`)
console.log(`  universal-only    ${missing.length}  (${toInsert.length} spliced, rest ride along)`)

/** Group by the desktop block each key is appended inside. */
const byParent = new Map()
for (const k of toInsert) {
  const parent = k.split('.').slice(0, -1).join('.')
  if (!byParent.has(parent)) byParent.set(parent, [])
  byParent.get(parent).push(k)
}

/** Shift a copied block from universal's indentation to desktop's. */
function reindent(src, from, to) {
  if (from === to) return src
  const pad = ' '.repeat(Math.abs(to - from))
  return src
    .split('\n')
    .map((l, i) => (i === 0 || !l.trim() ? l : to > from ? pad + l : l.startsWith(pad) ? l.slice(pad.length) : l))
    .join('\n')
}

// Splice back to front so earlier offsets stay valid.
const edits = [...byParent.entries()]
  .map(([parent, keys]) => ({
    at: parent === '' ? d.rootInner : d.nodes.get(parent).inner,
    indent: parent === '' ? 2 : d.nodes.get(parent).indent + 2,
    keys
  }))
  .sort((a, b) => b.at - a.at)

let out = d.text
let added = 0
for (const e of edits) {
  const blocks = e.keys.map(k => {
    const n = u.nodes.get(k)
    added += 1
    return ' '.repeat(e.indent) + reindent(u.text.slice(n.start, n.end), n.indent, e.indent)
  })
  const before = out.slice(0, e.at).trimEnd()
  // The preceding sibling needs a trailing comma before we append after it.
  const sep = SEP === '' ? (/[;{]$/.test(before) ? '' : ';') : /[,{]$/.test(before) ? '' : ','
  const joiner = SEP === '' ? '\n' : ',\n'
  out = `${before}${sep}\n${blocks.join(joiner)}\n${' '.repeat(Math.max(e.indent - 2, 0))}${out.slice(e.at)}`
}

console.log(`  spliced           ${added} blocks`)
if (shapeConflicts.length) {
  console.error(`\n  ${shapeConflicts.length} shape conflicts — not spliced, decide by hand:`)
  for (const c of [...new Set(shapeConflicts)]) console.error(`    ${c}`)
}

if (write) {
  fs.writeFileSync(universalFile, out)
  console.log(`  written           ${universalFile}`)
} else {
  console.log('  (dry run — pass --write)')
}
