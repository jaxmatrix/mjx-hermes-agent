#!/usr/bin/env node
/**
 * Resync `apps/hermes-universal/src` from `apps/desktop/src`.
 *
 * Desktop is the reference implementation and wins by default. Universal's
 * platform layer — the connection/tab/tunnel stores bound to Rust, the mobile
 * shell, the Tauri-only subsystems and the mobile/WebKit contracts — is named
 * in `sync/protected.txt` and is never overwritten.
 *
 * The point of this script is that the resync is reproducible. Running it
 * twice produces the same tree, and a future resync is a script run rather
 * than a project. It is deliberately dumb: it moves files and classifies them.
 * Everything that needs judgement lands in MERGE or REVIEW for a human.
 *
 *   node scripts/desktop-sync.mjs            # classify only, write the report
 *   node scripts/desktop-sync.mjs --apply    # also copy AUTO files into src/
 *
 * Buckets:
 *   AUTO   desktop's file wins           -> copied on --apply
 *   MERGE  protected, both sides differ  -> staged under sync/incoming/
 *   SKIP   protected, already identical  -> nothing to do
 *   REVIEW protected area, desktop-only  -> staged under sync/incoming/
 *   KEEP   universal-only                -> untouched, reported for visibility
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const DESKTOP_SRC = path.resolve(APP, '..', 'desktop', 'src')
const UNIVERSAL_SRC = path.join(APP, 'src')
const SYNC_DIR = path.join(APP, 'sync')
const INCOMING = path.join(SYNC_DIR, 'incoming')
const REPORT = path.join(SYNC_DIR, 'report.tsv')

const apply = process.argv.includes('--apply')

/** Every file under `root`, as paths relative to it, sorted. */
function walk(root) {
  const out = []
  const visit = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) visit(abs)
      else if (entry.isFile()) out.push(path.relative(root, abs))
    }
  }
  visit(root)
  return out.sort()
}

/** Comment- and blank-stripped lines of a manifest. */
function manifest(file) {
  return fs
    .readFileSync(path.join(SYNC_DIR, file), 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
}

/**
 * Glob -> RegExp. `**` crosses slashes, `*` and `?` do not. Everything else is
 * literal, so a `.` in a path never acts as a wildcard.
 */
function globToRegExp(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*'
        i += 1
        // `a/**/b` should also match `a/b`, so swallow a trailing slash.
        if (glob[i + 1] === '/') i += 1
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

const renames = manifest('renames.txt')
  .map(line => {
    const [from, to] = line.split('->').map(s => s.trim())
    if (!from || !to) throw new Error(`bad rename line: ${line}`)
    return { from, to }
  })
  // Longest prefix first, so a more specific rename cannot be shadowed.
  .sort((a, b) => b.from.length - a.from.length)

// A `!` line carves an exception out of a broader glob above it, so a whole
// subsystem can be protected without having to spell out the one file inside it
// that desktop should still own. Last match wins, as in .gitignore.
const protectedRules = manifest('protected.txt').map(line =>
  line.startsWith('!')
    ? { negate: true, re: globToRegExp(line.slice(1).trim()) }
    : { negate: false, re: globToRegExp(line) }
)

const rename = p => {
  const hit = renames.find(r => p.startsWith(r.from))
  return hit ? hit.to + p.slice(hit.from.length) : p
}
const isProtected = p => {
  let verdict = false
  for (const rule of protectedRules) if (rule.re.test(p)) verdict = !rule.negate
  return verdict
}

const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')

/**
 * Markers that mean universal's copy of a file carries platform work desktop
 * cannot know about. An AUTO file that matches is still overwritten — desktop
 * wins — but the patch has to be re-applied afterwards, so it goes on the
 * phase-3 worklist rather than being silently dropped.
 */
const PATCH_MARKERS =
  /@tauri-apps|@\/transport|@\/voice|@\/observability|observability\/|IS_MOBILE|isMobile|is-mobile|keyboard-inset|safe-area|visualViewport|visual-viewport|webkit|WKWebView/i

/**
 * The export surface of a module. Desktop reorganises constantly — a symbol
 * universal still calls can move to a different file, or stop existing.
 * Overwriting is right either way, but the caller has to be re-pointed, and
 * nothing else in this script would notice: the file compiles, the import
 * fails somewhere else entirely. This is how `lib/platform.ts` quietly lost
 * IS_MOBILE and `lib/query-client.ts` lost the helper `test-setup.ts` calls.
 */
const EXPORT_RE = /^export\s+(?:async\s+)?(?:const|let|var|function|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/gm

function exportedNames(file) {
  try {
    return new Set([...fs.readFileSync(file, 'utf8').matchAll(EXPORT_RE)].map(m => m[1]))
  } catch {
    return new Set()
  }
}

function carriesPatch(file) {
  // Binary assets never do, and reading them as text is wasteful.
  if (/\.(png|jpe?g|gif|svg|woff2?|ttf|mp3|wav|ico)$/i.test(file)) return false
  try {
    return PATCH_MARKERS.test(fs.readFileSync(file, 'utf8'))
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------

const desktopFiles = walk(DESKTOP_SRC)
const universalFiles = new Set(walk(UNIVERSAL_SRC))

const rows = []
const counts = { AUTO: 0, MERGE: 0, SKIP: 0, REVIEW: 0, KEEP: 0 }
/** Desktop paths that two renames collapsed onto one target. */
const targets = new Map()

for (const src of desktopFiles) {
  const dest = rename(src)
  if (targets.has(dest)) {
    throw new Error(`rename collision: ${targets.get(dest)} and ${src} both map to ${dest}`)
  }
  targets.set(dest, src)

  const exists = universalFiles.has(dest)
  const identical = exists && sha(path.join(DESKTOP_SRC, src)) === sha(path.join(UNIVERSAL_SRC, dest))

  let bucket
  if (!isProtected(dest)) bucket = 'AUTO'
  else if (!exists) bucket = 'REVIEW'
  else if (identical) bucket = 'SKIP'
  else bucket = 'MERGE'

  // An AUTO file that overwrites universal platform work is still overwritten,
  // but it has to be re-patched in phase 3 — flag it rather than lose it.
  const overwriting = bucket === 'AUTO' && exists && !identical
  const patch = overwriting && carriesPatch(path.join(UNIVERSAL_SRC, dest))

  // Symbols universal exported that desktop's replacement does not. Computed
  // here, before the copy, because afterwards the evidence is gone.
  let dropped = []
  if (overwriting && /\.tsx?$/.test(dest)) {
    const after = exportedNames(path.join(DESKTOP_SRC, src))
    dropped = [...exportedNames(path.join(UNIVERSAL_SRC, dest))].filter(n => !after.has(n))
  }

  rows.push({ bucket, src, dest, identical, exists, patch, dropped })
  counts[bucket] += 1
}

for (const p of universalFiles) {
  if (!targets.has(p)) {
    rows.push({ bucket: 'KEEP', src: '', dest: p, identical: false, exists: true })
    counts.KEEP += 1
  }
}

// ---------------------------------------------------------------------------
// The invariant that makes this safe to run: every file that exists on both
// sides with differing contents must be consciously bucketed. AUTO means we
// chose desktop; MERGE means we chose a human. Nothing else is acceptable —
// a conflicting file quietly landing in SKIP or KEEP would be a silent drop.

const conflicts = rows.filter(r => r.exists && !r.identical && r.src)
const unaccounted = conflicts.filter(r => r.bucket !== 'AUTO' && r.bucket !== 'MERGE')
if (unaccounted.length) {
  for (const r of unaccounted) console.error(`unaccounted conflict: ${r.dest} (${r.bucket})`)
  throw new Error(`${unaccounted.length} conflicting files are neither AUTO nor MERGE`)
}

fs.mkdirSync(SYNC_DIR, { recursive: true })
fs.writeFileSync(
  REPORT,
  [
    'bucket\tpatch\tdesktop\tuniversal',
    ...rows.map(r => `${r.bucket}\t${r.patch ? 'PATCH' : '-'}\t${r.src}\t${r.dest}`)
  ].join('\n') + '\n'
)

// Both worklists are only meaningful during a real resync, when the
// classification above still saw universal's pre-copy files. A dry run AFTER one
// compares desktop against itself and finds nothing — writing that would erase a
// worklist still being worked through, which is exactly what happened to both.
const patched = rows.filter(r => r.patch)
if (apply || patched.length)
  fs.writeFileSync(
    path.join(SYNC_DIR, 'patch-worklist.txt'),
    '# Phase 3 worklist: AUTO files whose universal version carried platform work\n' +
      "# (Tauri, observability, mobile, WebKit) that desktop's version overwrites.\n" +
      '# Recover each from the phase-1 commit: git show <phase1>^:<path>\n' +
      patched.map(r => r.dest).join('\n') +
      '\n'
  )

const losing = rows.filter(r => r.dropped?.length)
if (apply || losing.length)
  fs.writeFileSync(
    path.join(SYNC_DIR, 'dropped-exports.txt'),
    "# Symbols universal exported that desktop's version of the same file does not.\n" +
      '# Each is either a symbol desktop MOVED (re-point the caller at its new home)\n' +
      '# or one desktop dropped (delete or rewrite the caller). Never restore onto\n' +
      '# an AUTO file — that re-forks the absorb cycle. Recover archaeology with:\n' +
      '#   git show archive/hermes-universal-pre-pipeline:apps/hermes-universal/<path>\n' +
      losing.map(r => `\n${r.dest}\n` + r.dropped.map(n => `    ${n}`).join('\n')).join('') +
      '\n'
  )

// Two blind spots of a path-by-path comparison, reported rather than thrown
// because resolving them takes judgement: `x.ts` beside `x.tsx` (desktop changed
// the extension, so both now exist), and `x.ts(x)` beside `x/index.ts(x)` (module
// resolution picks the file and the directory goes dead).
const tree = new Set([...universalFiles, ...targets.keys()])
const collisions = []
for (const p of [...tree].sort()) {
  if (!/\.tsx?$/.test(p)) continue
  if (p.endsWith('.ts') && tree.has(`${p}x`)) collisions.push(`extension  ${p}  <->  ${p}x`)
  const stem = p.replace(/\.tsx?$/, '')
  for (const index of [`${stem}/index.ts`, `${stem}/index.tsx`]) {
    if (tree.has(index)) collisions.push(`shadow     ${p}  <->  ${index}`)
  }
}

const added = rows.filter(r => r.bucket === 'AUTO' && !r.exists).length
const churn = rows.filter(r => r.bucket === 'AUTO' && r.exists && !r.identical).length
const noop = counts.AUTO - added - churn

console.log(`desktop     ${desktopFiles.length} files`)
console.log(`universal   ${universalFiles.size} files`)
console.log(`conflicts   ${conflicts.length} (present in both, differing)`)
console.log('')
console.log(`AUTO        ${counts.AUTO}\t${added} new, ${churn} overwritten, ${noop} unchanged`)
console.log(`MERGE       ${counts.MERGE}\tprotected and conflicting — hand-merge`)
console.log(`SKIP        ${counts.SKIP}\tprotected, already identical`)
console.log(`REVIEW      ${counts.REVIEW}\tdesktop-only inside a protected area`)
console.log(`KEEP        ${counts.KEEP}\tuniversal-only, untouched`)
console.log('')
console.log(`PATCH       ${patched.length}\tof the overwritten carry platform work — phase 3`)
console.log(
  `DROPPED     ${losing.length}\tof the overwritten lose ${losing.reduce((n, r) => n + r.dropped.length, 0)} exported symbols`
)
console.log('')
console.log(`collisions  ${collisions.length}\tsame module under two paths — resolve by hand`)
for (const c of collisions) console.log(`  ${c}`)
console.log('')
console.log(`report      sync/report.tsv`)
console.log(`worklist    sync/patch-worklist.txt`)
console.log(`dropped     sync/dropped-exports.txt`)

if (!apply) {
  console.log('\ndry run — pass --apply to write files')
  process.exit(0)
}

fs.rmSync(INCOMING, { recursive: true, force: true })
let copied = 0
let staged = 0
for (const r of rows) {
  const from = path.join(DESKTOP_SRC, r.src)
  if (r.bucket === 'AUTO') {
    const to = path.join(UNIVERSAL_SRC, r.dest)
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.copyFileSync(from, to)
    copied += 1
  } else if (r.bucket === 'MERGE' || r.bucket === 'REVIEW') {
    const to = path.join(INCOMING, r.dest)
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.copyFileSync(from, to)
    staged += 1
  }
}
console.log(`\napplied     ${copied} files copied into src/`)
console.log(`staged      ${staged} files under sync/incoming/ for review`)

// ---------------------------------------------------------------------------
// Renaming a file is only half the job: the imports that name it have to follow.
// Desktop's source says `@/app/right-sidebar/store` and `@/components/pet/…`,
// which resolve nowhere once those trees land under universal's names. Rewrite
// every specifier through the same rename map, resolving relative ones to an
// src-relative path first so that `../right-sidebar/store` is caught too.

const SPEC_RE = /(\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(['"])([^'"]+)\2/g

function rewriteSpecifier(spec, fileDir) {
  const alias = spec.startsWith('@/')
  const relative = spec.startsWith('./') || spec.startsWith('../')
  if (!alias && !relative) return spec

  // Resolve to a path relative to src/, which is the space the rename map lives in.
  const abs = alias ? spec.slice(2) : path.posix.normalize(path.posix.join(fileDir, spec))
  // A directory rename also has to catch the bare form — `@/app/right-sidebar`
  // resolving to that directory's index is just as common as naming a file in it.
  const hit = renames.find(r => abs.startsWith(r.from) || abs === r.from.replace(/\/$/, ''))
  if (!hit) return spec
  const moved = abs.startsWith(hit.from) ? hit.to + abs.slice(hit.from.length) : hit.to.replace(/\/$/, '')

  if (alias) return `@/${moved}`
  // Re-relativize against the importing file so the result still points at it.
  const rel = path.posix.relative(fileDir, moved)
  return rel.startsWith('.') ? rel : `./${rel}`
}

let rewritten = 0
for (const rel of walk(UNIVERSAL_SRC)) {
  if (!/\.(tsx?|mts|cts)$/.test(rel)) continue
  const file = path.join(UNIVERSAL_SRC, rel)
  const before = fs.readFileSync(file, 'utf8')
  const dir = path.posix.dirname(rel)
  const after = before.replace(SPEC_RE, (m, lead, q, spec) => {
    const next = rewriteSpecifier(spec, dir)
    return next === spec ? m : `${lead}${q}${next}${q}`
  })
  if (after !== before) {
    fs.writeFileSync(file, after)
    rewritten += 1
  }
}
console.log(`rewrote     ${rewritten} files whose imports named a renamed path`)

// ---------------------------------------------------------------------------
// A handful of desktop's src/ files import pure type modules out of its
// `electron/` directory (payload shapes shared between the main process and the
// renderer). Mirroring those modules at the same relative path is what lets the
// imports resolve unchanged — rewriting them instead would mean redoing the
// rewrite on every future resync. Only dependency-free modules qualify: if one
// ever grows an import, this throws rather than dragging the main process in.

const ELECTRON_SRC = path.resolve(APP, '..', 'desktop', 'electron')
const ELECTRON_DEST = path.join(APP, 'electron')
const needed = new Set()
for (const rel of walk(UNIVERSAL_SRC)) {
  if (!/\.tsx?$/.test(rel)) continue
  const text = fs.readFileSync(path.join(UNIVERSAL_SRC, rel), 'utf8')
  for (const m of text.matchAll(/from '(?:\.\.\/)+electron\/([\w-]+)'/g)) needed.add(m[1])
}

fs.rmSync(ELECTRON_DEST, { recursive: true, force: true })
for (const name of needed) {
  const from = path.join(ELECTRON_SRC, `${name}.ts`)
  const text = fs.readFileSync(from, 'utf8')
  if (/^import\s/m.test(text)) {
    throw new Error(`electron/${name}.ts is no longer dependency-free — it cannot be mirrored`)
  }
  fs.mkdirSync(ELECTRON_DEST, { recursive: true })
  fs.copyFileSync(from, path.join(ELECTRON_DEST, `${name}.ts`))
}
console.log(`mirrored    ${needed.size} dependency-free electron/ type modules`)
