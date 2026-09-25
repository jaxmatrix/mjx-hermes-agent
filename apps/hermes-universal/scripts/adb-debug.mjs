#!/usr/bin/env node
/**
 * Android adb helpers for local debug captures during `android:dev`.
 *
 * Writes under `debug_files/` (gitignored). Modes:
 *
 *   node scripts/adb-debug.mjs screenshot      # one PNG
 *   node scripts/adb-debug.mjs logcat          # follow filtered logcat until Ctrl-C
 *   node scripts/adb-debug.mjs debug-capture   # PNG + dump of current logcat buffer
 *
 * Filters favour the Hermes Rust tag (`hermes`) plus common WebView / Chromium
 * noise so Vite HMR and JS console lines still show up.
 *
 * Sessions-route diagnosis: look for `[hermes-sessions]` (JS) and
 * `[transport] http_send_failed` (Rust). Reproduce: open Sessions → tap a chat.
 */

import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEBUG_ROOT = join(ROOT, 'debug_files')

/** Tags that usually matter for universal Android / WebView debugging. */
const LOGCAT_FILTER =
  'hermes:V RustStdoutStderr:V chromium:V Chromium:V WebView:V chromiumConsole:V *:S'

function stamp() {
  const d = new Date()
  const p = n => String(n).padStart(2, '0')

  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  )
}

function ensureAdb() {
  const check = spawnSync('adb', ['get-state'], { encoding: 'utf8' })

  if (check.error?.code === 'ENOENT') {
    console.error('adb not found on PATH. Install platform-tools and try again.')
    process.exit(1)
  }

  const state = (check.stdout || '').trim()

  if (check.status !== 0 || state !== 'device') {
    console.error(
      `No Android device ready (adb get-state → ${state || check.stderr?.trim() || 'unknown'}).`
    )
    process.exit(1)
  }
}

function captureDir(label) {
  const dir = join(DEBUG_ROOT, `${stamp()}${label ? `-${label}` : ''}`)
  mkdirSync(dir, { recursive: true })

  return dir
}

function takeScreenshot(outDir) {
  const outPath = join(outDir, 'screen.png')
  const result = spawnSync('adb', ['exec-out', 'screencap', '-p'], {
    encoding: 'buffer',
    maxBuffer: 32 * 1024 * 1024
  })

  if (result.status !== 0) {
    console.error(result.stderr?.toString() || 'screencap failed')
    process.exit(result.status ?? 1)
  }

  writeFileSync(outPath, result.stdout)
  console.log(`Wrote ${outPath}`)

  return outPath
}

function dumpLogcat(outDir) {
  const outPath = join(outDir, 'logcat.txt')
  const result = spawnSync('adb', ['logcat', '-d', '-v', 'time', LOGCAT_FILTER], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  })

  if (result.status !== 0) {
    console.error(result.stderr || 'logcat dump failed')
    process.exit(result.status ?? 1)
  }

  writeFileSync(outPath, result.stdout ?? '')
  console.log(`Wrote ${outPath}`)

  return outPath
}

function followLogcat(outDir) {
  const outPath = join(outDir, 'logcat.txt')
  console.log(`Tailing logcat → ${outPath} (Ctrl-C to stop)`)
  console.log(`Filter: ${LOGCAT_FILTER}`)

  // Clear so the follow starts from "now", then tee into the file.
  spawnSync('adb', ['logcat', '-c'])

  const child = spawn('adb', ['logcat', '-v', 'time', LOGCAT_FILTER], {
    stdio: ['ignore', 'pipe', 'pipe']
  })

  const chunks = []
  const onChunk = chunk => {
    chunks.push(chunk)
    process.stdout.write(chunk)
  }

  child.stdout.on('data', onChunk)
  child.stderr.on('data', chunk => process.stderr.write(chunk))

  const flush = () => {
    writeFileSync(outPath, Buffer.concat(chunks))
  }

  const stop = code => {
    flush()
    console.log(`\nWrote ${outPath}`)
    process.exit(code ?? 0)
  }

  process.on('SIGINT', () => {
    child.kill('SIGINT')
    stop(0)
  })
  process.on('SIGTERM', () => {
    child.kill('SIGTERM')
    stop(0)
  })

  child.on('exit', code => stop(code ?? 0))
}

function usage() {
  console.log(`Usage:
  node scripts/adb-debug.mjs screenshot
  node scripts/adb-debug.mjs logcat
  node scripts/adb-debug.mjs debug-capture

Output lands in apps/hermes-universal/debug_files/<stamp>/ (gitignored).`)
}

function main() {
  const mode = process.argv[2]

  if (!mode || mode === '--help' || mode === '-h') {
    usage()
    process.exit(mode ? 0 : 1)
  }

  ensureAdb()

  if (mode === 'screenshot') {
    const dir = captureDir('screen')
    takeScreenshot(dir)
    return
  }

  if (mode === 'logcat') {
    const dir = captureDir('logcat')
    followLogcat(dir)
    return
  }

  if (mode === 'debug-capture') {
    const dir = captureDir('capture')
    takeScreenshot(dir)
    dumpLogcat(dir)
    console.log(`Capture folder: ${dir}`)
    return
  }

  console.error(`Unknown mode: ${mode}`)
  usage()
  process.exit(1)
}

main()
