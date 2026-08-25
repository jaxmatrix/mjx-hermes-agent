import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { parseHermesDeepLink, resolveDeepLinkAction } from './deep-link-routes'
import { RESERVED_DEEP_LINK_KINDS } from './hermes-open-target'

const parse = (url: string) => parseHermesDeepLink(url)

const act = (url: string) => {
  const payload = parseHermesDeepLink(url)

  if (!payload) {
    throw new Error(`expected ${url} to parse`)
  }

  return resolveDeepLinkAction(payload)
}

describe('parseHermesDeepLink', () => {
  it('reads the host as the kind and the path as the name', () => {
    expect(parse('hermes://mcp/install?name=x')).toEqual({
      kind: 'mcp',
      name: 'install',
      params: { name: 'x' },
      url: 'hermes://mcp/install?name=x'
    })
  })

  it('keeps a multi-segment name whole', () => {
    expect(parse('hermes://index-network/intent/1')?.name).toBe('intent/1')
  })

  it('tolerates a trailing slash', () => {
    expect(parse('hermes://mcp/install/?name=x')?.name).toBe('install')
  })

  it.each(['not a url at all', 'https://mcp.example.com/mcp/install?name=x', 'cursor://x/mcp/install'])(
    'returns null for %s',
    url => {
      expect(parse(url)).toBeNull()
    }
  )
})

// ── the disjointness invariant (§8.2) ────────────────────────────────────────
// Every app-level Tauri EVENT in this codebase is `hermes://<kebab-name>` with
// no path; every deep-link ROUTE has one. Registering `hermes` as a real URL
// scheme put a second meaning on the same prefix, and this is what keeps them
// from ever being confusable.
//
// SCANNED rather than listed: a hardcoded list decays the moment someone adds an
// event, which is precisely when the invariant needs checking.

const APP_DIR = process.cwd()
const SINGLE_SEGMENT = /hermes:\/\/([A-Za-z0-9._-]+)(?![A-Za-z0-9._/-])/g

function sourceFiles(dir: string, extensions: string[], out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)

    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== 'target' && entry.name !== 'gen') {
        sourceFiles(full, extensions, out)
      }
    } else if (extensions.some(ext => entry.name.endsWith(ext)) && !/\.test\.[a-z]+$/.test(entry.name)) {
      // Test files carry FIXTURE urls (`hermes://mcp?name=x`), which are the
      // opposite of an event name — including them would assert against the very
      // strings written to prove a route is refused.
      out.push(full)
    }
  }

  return out
}

function appEventNames(): string[] {
  const files = [
    ...sourceFiles(path.join(APP_DIR, 'src'), ['.ts', '.tsx']),
    ...sourceFiles(path.join(APP_DIR, 'src-tauri', 'src'), ['.rs'])
  ]

  const names = new Set<string>()

  for (const file of files) {
    for (const match of fs.readFileSync(file, 'utf8').matchAll(SINGLE_SEGMENT)) {
      names.add(match[1])
    }
  }

  return [...names].sort()
}

describe('a Tauri event name is never a deep-link route', () => {
  it('found the event names to check (a silent empty scan would pass vacuously)', () => {
    const names = appEventNames()

    expect(names.length).toBeGreaterThan(5)
    // The one this ticket adds, so a broken scanner is visible rather than green.
    expect(names).toContain('deep-link-open')
  })

  it('parses every app event name to null', () => {
    for (const name of appEventNames()) {
      expect(parseHermesDeepLink(`hermes://${name}`), name).toBeNull()
    }
  })

  it('never spells a reserved deep-link kind as an app event name', () => {
    for (const name of appEventNames()) {
      expect(RESERVED_DEEP_LINK_KINDS.has(name), name).toBe(false)
    }
  })
})

describe('resolveDeepLinkAction', () => {
  it('classifies the MCP install link', () => {
    expect(act('hermes://mcp/install?name=demo&config=e30=')).toEqual({
      params: { config: 'e30=', name: 'demo' },
      type: 'mcp-install'
    })
  })

  it('classifies the unified plugin install link', () => {
    expect(act('hermes://plugin/install?repo=owner/repo')).toEqual({
      enable: true,
      force: false,
      legacyHint: null,
      repo: 'owner/repo',
      type: 'plugin-install'
    })
  })

  it.each([
    ['plugin-agent', 'agent'],
    ['plugin-desktop', 'desktop']
  ])('keeps %s as provenance', (kind, hint) => {
    expect(act(`hermes://${kind}/owner/repo`)).toMatchObject({ legacyHint: hint, repo: 'owner/repo' })
  })

  it('resolves repo from `repo`, then `identifier`, then the path', () => {
    expect(act('hermes://plugin/install?repo=a/one&identifier=b/two')).toMatchObject({ repo: 'a/one' })
    expect(act('hermes://plugin/install?identifier=b/two')).toMatchObject({ repo: 'b/two' })
    expect(act('hermes://plugin-agent/c/three')).toMatchObject({ repo: 'c/three' })
  })

  it.each([
    ['1', true],
    ['true', true],
    ['TRUE', true],
    ['yes', true],
    ['0', false],
    ['no', false],
    ['nonsense', false]
  ])('reads force=%s as %s', (value, expected) => {
    expect(act(`hermes://plugin/install?repo=o/r&force=${value}`)).toMatchObject({ force: expected })
  })

  it('defaults enable to true and force to false, including for a blank value', () => {
    expect(act('hermes://plugin/install?repo=o/r&enable=&force=')).toMatchObject({ enable: true, force: false })
  })

  it('reads enable=0 as off', () => {
    expect(act('hermes://plugin/install?repo=o/r&enable=0')).toMatchObject({ enable: false })
  })

  it('classifies a blueprint link with its slots', () => {
    expect(act('hermes://blueprint/ship-it?repo=hermes&branch=main')).toEqual({
      name: 'ship-it',
      params: { branch: 'main', repo: 'hermes' },
      type: 'composer-blueprint'
    })
  })

  it('classifies open/ and plugin-scoped links as navigations', () => {
    expect(act('hermes://open/skills?tab=mcp')).toEqual({ path: '/skills?tab=mcp', type: 'navigate' })
    expect(act('hermes://index-network/intent/1')).toEqual({ path: '/index-network/intent/1', type: 'navigate' })
  })

  it('refuses a traversal in the path rather than navigating to it', () => {
    expect(act('hermes://open/..%2F..%2Fetc%2Fpasswd')).toEqual({ reason: 'unsafe-path', type: 'ignore' })
  })

  it('names the reason when a core kind reaches the fallback', () => {
    // `plugin/install` with no repo named nothing to install, and it must not be
    // read as a navigation to `/plugin/install` either — nor, as on desktop, as
    // an install of a repository called `install`.
    expect(act('hermes://plugin/install')).toEqual({ reason: 'reserved-kind', type: 'ignore' })
    expect(act('hermes://settings/providers')).toEqual({ reason: 'reserved-kind', type: 'ignore' })
  })
})
