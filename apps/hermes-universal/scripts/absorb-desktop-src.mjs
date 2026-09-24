#!/usr/bin/env node
/**
 * Absorb `apps/desktop/src` into this package's `src/`.
 *
 * Thin-host pipeline entry point. Delegates to `desktop-sync.mjs`, which
 * copies unprotected paths from desktop (ground truth) and leaves
 * `sync/protected.txt` paths alone.
 *
 *   npm run absorb-desktop-src           # apply
 *   npm run absorb-desktop-src -- --dry  # classify only (no copy)
 */

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const dry = process.argv.includes('--dry')
const args = dry ? [] : ['--apply']

const result = spawnSync(process.execPath, [path.join(here, 'desktop-sync.mjs'), ...args], {
  stdio: 'inherit',
  cwd: path.join(here, '..')
})

process.exit(result.status ?? 1)
