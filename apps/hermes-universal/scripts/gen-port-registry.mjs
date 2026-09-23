#!/usr/bin/env node
/**
 * Build `sync/port-registry.json` from Electron's preload (the capability
 * catalog) plus optional decisions in `sync/port-decisions.json`.
 *
 * Detection begins at `apps/desktop/electron/preload.ts` — every
 * `hermesDesktop` member is a row. A decision maps that id to a status;
 * anything else is `undecided` (a port task on the next sync).
 *
 *   node scripts/gen-port-registry.mjs
 *   npm run gen-port-registry
 *
 * Statuses: ported | needs-Rust | needs-native | mobile-n/a | no-mapping |
 *           batch | undecided
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'

const APP = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const PRELOAD = path.resolve(APP, '..', 'desktop', 'electron', 'preload.ts')
const SYNC = path.join(APP, 'sync')
const DECISIONS = path.join(SYNC, 'port-decisions.json')
const OUT = path.join(SYNC, 'port-registry.json')

/** Every member `contextBridge.exposeInMainWorld('hermesDesktop', …)` publishes. */
function preloadSurface(sourceText) {
  const source = ts.createSourceFile(PRELOAD, sourceText, ts.ScriptTarget.Latest, true)
  const members = []

  const collect = (literal, prefix) => {
    for (const property of literal.properties) {
      const name = property.name?.getText(source)
      if (!name) {
        throw new Error('preload spreads or computes a member — teach gen-port-registry to read it')
      }
      if (ts.isPropertyAssignment(property) && ts.isObjectLiteralExpression(property.initializer)) {
        collect(property.initializer, `${prefix}${name}.`)
      } else {
        members.push(`${prefix}${name}`)
      }
    }
  }

  const visit = node => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === 'contextBridge.exposeInMainWorld' &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === 'hermesDesktop' &&
      ts.isObjectLiteralExpression(node.arguments[1])
    ) {
      collect(node.arguments[1], '')
    }
    ts.forEachChild(node, visit)
  }

  visit(source)
  return members
}

/** Best-effort ipc channel from the member's initializer text. */
function ipcChannel(sourceText, member) {
  const parts = member.split('.')
  // Rough: look for hermes:… near the property name in preload source.
  const leaf = parts[parts.length - 1]
  const re = new RegExp(`\\b${leaf}\\b[\\s\\S]{0,200}?['"](hermes:[^'"]+)['"]`)
  const m = sourceText.match(re)
  return m ? m[1] : null
}

function classifyReason(reason) {
  if (!reason) return { status: 'undecided', reason: null }
  if (
    /^no mapping:/i.test(reason) ||
    /^no correct mapping:/i.test(reason) ||
    /^owned elsewhere:/i.test(reason) ||
    /^cannot fire:/i.test(reason)
  ) {
    return { status: 'no-mapping', reason }
  }
  if (/^needs Rust:/i.test(reason)) return { status: 'needs-Rust', reason }
  if (/needs-native|plugin:mic|WKWebView|chromium/i.test(reason)) return { status: 'needs-native', reason }
  if (/mobile-n\/a|phone/i.test(reason)) return { status: 'mobile-n/a', reason }
  if (/^batch /i.test(reason)) return { status: 'batch', reason }
  if (/^ported$/i.test(reason)) return { status: 'ported', reason }
  return { status: 'undecided', reason }
}

function decisionFor(member, decisions) {
  // Longest key wins (namespace covers children), same idea as NOT_YET waived().
  const keys = Object.keys(decisions).sort((a, b) => b.length - a.length)
  for (const key of keys) {
    if (member === key || member.startsWith(`${key}.`)) {
      return classifyReason(decisions[key])
    }
  }
  // No decision row means the bridge is expected to implement it — same as
  // preload-drift: absent from NOT_YET ⇒ must be on window.hermesDesktop.
  return {
    status: 'ported',
    reason: 'not in port-decisions.json — preload-drift requires the bridge to expose it'
  }
}

const sourceText = fs.readFileSync(PRELOAD, 'utf8')
const members = preloadSurface(sourceText)
const decisions = fs.existsSync(DECISIONS) ? JSON.parse(fs.readFileSync(DECISIONS, 'utf8')) : {}

const generatedAt = new Date().toISOString()
const rows = members.map(id => {
  const { status, reason } = decisionFor(id, decisions)
  return {
    id,
    ipc: ipcChannel(sourceText, id),
    status,
    reason,
    platforms: status === 'mobile-n/a' ? ['desktop-webview'] : ['desktop-webview', 'android', 'ios']
  }
})

const counts = rows.reduce((acc, row) => {
  acc[row.status] = (acc[row.status] ?? 0) + 1
  return acc
}, {})

const registry = {
  version: 1,
  source: 'apps/desktop/electron/preload.ts',
  archiveBranch: 'archive/hermes-universal-pre-pipeline',
  generatedAt,
  counts,
  members: rows
}

fs.mkdirSync(SYNC, { recursive: true })
fs.writeFileSync(OUT, `${JSON.stringify(registry, null, 2)}\n`)

const undecided = counts.undecided ?? 0
console.log(`port-registry  ${rows.length} members → ${path.relative(APP, OUT)}`)
console.log(
  Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, n]) => `  ${k.padEnd(14)} ${n}`)
    .join('\n')
)
if (undecided > 0) {
  console.log(`\n${undecided} undecided — classify in sync/port-decisions.json.`)
}
