/**
 * Event-driven workspace change tick — desktop's `workspace-events` shape.
 * (Profile-scoped default-cwd atoms lived here pre-absorb; those call sites
 * now use `$currentCwd` / `store/effective-cwd`.)
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  $workspaceChangeTick,
  consumeWorkspaceChange,
  notifyWorkspaceChanged,
  toolChangedPath,
  toolMayMutateFiles
} from '@/store/workspace-events'

beforeEach(() => {
  // Drain any pending change left by a prior test.
  consumeWorkspaceChange()
  $workspaceChangeTick.set(0)
})

describe('notifyWorkspaceChanged', () => {
  it('bumps the tick and records a parent dir for an absolute path', () => {
    const before = $workspaceChangeTick.get()

    notifyWorkspaceChanged('/srv/work/file.ts')

    expect($workspaceChangeTick.get()).toBe(before + 1)
    expect(consumeWorkspaceChange()).toEqual({ dirs: ['/srv/work'], full: false })
  })

  it('marks a full rescan when the path is relative or omitted', () => {
    notifyWorkspaceChanged('relative.ts')
    expect(consumeWorkspaceChange()).toEqual({ dirs: [], full: true })

    notifyWorkspaceChanged()
    expect(consumeWorkspaceChange()).toEqual({ dirs: [], full: true })
  })
})

describe('toolMayMutateFiles / toolChangedPath', () => {
  it('treats write-like tools and inline diffs as mutations', () => {
    expect(toolMayMutateFiles({ name: 'write_file' })).toBe(true)
    expect(toolMayMutateFiles({ name: 'read_file' })).toBe(false)
    expect(toolMayMutateFiles({ name: 'search', inline_diff: '--- a\n+++ b' })).toBe(true)
  })

  it('pulls a single path arg when present', () => {
    expect(toolChangedPath({ args: { path: '/srv/a.ts' } })).toBe('/srv/a.ts')
    expect(toolChangedPath({ args: { file_path: '/srv/b.ts' } })).toBe('/srv/b.ts')
    expect(toolChangedPath({ arguments: { cmd: 'ls' } })).toBeUndefined()
  })
})

// Keep vitest from complaining about unused vi in case we extend later.
void vi
