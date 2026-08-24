import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  backendScopeKey,
  backendScopePrefix,
  connectionIdOf,
  LOCAL_CONNECTION_ID,
  registryBackendScopeKey,
  setConnectionIdResolver
} from '@/lib/backend-scope'
import type { Connection } from '@/store/gateway-config'

const conn = (patch: Partial<Connection>): Connection => ({ authMode: 'none', baseUrl: 'http://a.example', ...patch })

describe('backendScopeKey', () => {
  // T26 — the byte-identity claim the whole vendoring rests on: a single-source
  // user's scope key must stay the bare profile, or every pool entry, reaper log
  // line and cache key in the app moves the day the registry lands.
  it('collapses the local connection to the bare profile key', () => {
    expect(backendScopeKey(LOCAL_CONNECTION_ID, 'work')).toBe('work')
    expect(backendScopeKey(null, null)).toBe('default')
    expect(backendScopeKey('', '  ')).toBe('default')
  })

  it('namespaces a non-local connection', () => {
    expect(backendScopeKey('box-2', 'work')).toBe('conn:box-2::work')
    expect(backendScopePrefix('box-2')).toBe('conn:box-2::')
  })

  it('keeps an explicit local id in the registry key', () => {
    expect(registryBackendScopeKey(LOCAL_CONNECTION_ID, 'work')).toBe('conn:local::work')
    expect(registryBackendScopeKey(null, 'work')).toBe('work')
  })

  // The vendoring contract: desktop's Electron main and this renderer must
  // derive the same key. A drift here is invisible until two processes disagree
  // about which pool entry a session belongs to.
  it('is byte-identical to the shared copy for the three vendored functions', () => {
    const shared = fs.readFileSync(path.resolve(process.cwd(), '../../apps/shared/src/backend-scope.ts'), 'utf8')
    const mine = fs.readFileSync(path.resolve(process.cwd(), 'src/lib/backend-scope.ts'), 'utf8')

    const bodies = (source: string) =>
      ['backendScopeKey', 'registryBackendScopeKey', 'backendScopePrefix']
        .map(name => source.slice(source.indexOf(`export function ${name}`)).split('\n}')[0])
        .join('\n---\n')

    expect(bodies(mine)).toBe(bodies(shared))
  })
})

describe('connectionIdOf', () => {
  // T27 — rule 19. An ssh baseUrl is `http://127.0.0.1:<ephemeral>`, freshly
  // minted on every re-tunnel, so identity must come off `remoteIdentity`.
  it('uses remoteIdentity for ssh and never the baseUrl', () => {
    const ssh = conn({ baseUrl: 'http://127.0.0.1:49213', mode: 'ssh', remoteHost: 'me@box', remoteIdentity: 'box:22' })

    expect(connectionIdOf(ssh)).toBe('box:22')
    expect(connectionIdOf({ ...ssh, remoteIdentity: undefined })).toBe('me@box')
  })

  it('collapses local (and no connection at all) to the local id', () => {
    expect(connectionIdOf(conn({ mode: 'local' }))).toBe(LOCAL_CONNECTION_ID)
    expect(connectionIdOf(null)).toBe(LOCAL_CONNECTION_ID)
  })

  it('uses the baseUrl for remote and cloud', () => {
    expect(connectionIdOf(conn({ baseUrl: 'https://b.example', mode: 'cloud' }))).toBe('https://b.example')
    expect(connectionIdOf(conn({ baseUrl: 'https://b.example' }))).toBe('https://b.example')
  })

  it('prefers a registered resolver, falls back when it answers blank, and restores idempotently', () => {
    const remote = conn({ baseUrl: 'https://b.example' })
    const restore = setConnectionIdResolver(() => 'registry-slug')

    expect(connectionIdOf(remote)).toBe('registry-slug')

    const inner = setConnectionIdResolver(() => '  ')

    // A registry with no row for this connection falls back to the derivation
    // rather than minting a second identity.
    expect(connectionIdOf(remote)).toBe('https://b.example')

    // Stale restore: `inner` is current, so the outer one must not clobber it.
    restore()
    expect(connectionIdOf(remote)).toBe('https://b.example')

    inner()
    expect(connectionIdOf(remote)).toBe('registry-slug')
    restore()
    expect(connectionIdOf(remote)).toBe('https://b.example')
  })
})
