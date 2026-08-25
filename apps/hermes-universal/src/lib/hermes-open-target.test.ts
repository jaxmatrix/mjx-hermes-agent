import { describe, expect, it } from 'vitest'

import {
  isPluginDeepLinkHost,
  isSafeAppPath,
  normalizeHermesOpenString,
  pathFromHermesDeepLink,
  RESERVED_DEEP_LINK_KINDS,
  resolveHermesOpenPath
} from './hermes-open-target'

describe('isSafeAppPath', () => {
  it.each(['/kanban', '/settings/providers', '/index-network/intent/1', '/a?b=c'])('accepts %s', path => {
    expect(isSafeAppPath(path)).toBe(true)
  })

  // Every one of these is something a hostile page can put in a `hermes://` URL.
  it.each([
    ['relative', 'kanban'],
    ['protocol-relative', '//evil.example/x'],
    ['traversal', '/../../etc/passwd'],
    ['traversal mid-path', '/a/../b'],
    ['windows separator', '/a\\b'],
    ['scheme smuggling', '/javascript:alert(1)'],
    ['empty', '']
  ])('refuses a %s path', (_label, path) => {
    expect(isSafeAppPath(path)).toBe(false)
  })
})

describe('isPluginDeepLinkHost', () => {
  it('accepts a plugin slug', () => {
    expect(isPluginDeepLinkHost('index-network')).toBe(true)
  })

  it('refuses every reserved kind, so a plugin cannot squat on a core route', () => {
    for (const kind of RESERVED_DEEP_LINK_KINDS) {
      expect(isPluginDeepLinkHost(kind), kind).toBe(false)
    }
  })

  it.each(['Index', '-lead', '', 'a_b', 'a.b'])('refuses %s', host => {
    expect(isPluginDeepLinkHost(host)).toBe(false)
  })
})

describe('normalizeHermesOpenString', () => {
  it('maps hermes://open/<rest> to a root path', () => {
    expect(normalizeHermesOpenString('hermes://open/my-page')).toBe('/my-page')
  })

  it('keeps the query on an open link', () => {
    expect(normalizeHermesOpenString('hermes://open/my-page?item=x')).toBe('/my-page?item=x')
  })

  it('scopes a plugin host as the first path segment', () => {
    expect(normalizeHermesOpenString('hermes://index-network/intent/1')).toBe('/index-network/intent/1')
  })

  it('refuses a reserved kind read as a plugin id', () => {
    expect(normalizeHermesOpenString('hermes://settings/providers')).toBeNull()
  })

  // A literal `../` never reaches the guard — WHATWG resolves it while parsing,
  // so `hermes://open/../../etc/passwd` arrives as the perfectly ordinary path
  // `/etc/passwd`. The traversal that DOES survive the parser is a
  // percent-encoded one, and that is the one worth pinning.
  it('refuses a percent-encoded traversal, which the URL parser does not collapse', () => {
    expect(normalizeHermesOpenString('hermes://open/..%2F..%2Fetc%2Fpasswd')).toBeNull()
    expect(normalizeHermesOpenString('/a/..%2Fb')).toBeNull()
  })

  it('lets the URL parser resolve a literal ../ before the guard sees it', () => {
    expect(normalizeHermesOpenString('hermes://open/../../etc/passwd')).toBe('/etc/passwd')
  })

  it('refuses an empty rest', () => {
    expect(normalizeHermesOpenString('hermes://open')).toBeNull()
    expect(normalizeHermesOpenString('hermes://index-network')).toBeNull()
  })

  it('accepts a hash-router path and strips the hash', () => {
    expect(normalizeHermesOpenString('#/skills?tab=mcp')).toBe('/skills?tab=mcp')
    expect(normalizeHermesOpenString('  /skills  ')).toBe('/skills')
  })

  it('refuses a bare word, which is not a path', () => {
    expect(normalizeHermesOpenString('skills')).toBeNull()
    expect(normalizeHermesOpenString('')).toBeNull()
  })
})

describe('resolveHermesOpenPath', () => {
  it('takes a string, an { href } and a { path, params }', () => {
    expect(resolveHermesOpenPath('/skills')).toBe('/skills')
    expect(resolveHermesOpenPath({ href: 'hermes://open/skills' })).toBe('/skills')
    expect(resolveHermesOpenPath({ params: { tab: 'mcp' }, path: '/skills' })).toBe('/skills?tab=mcp')
  })

  it('merges params onto a path that already has a query', () => {
    expect(resolveHermesOpenPath({ params: { server: 'x' }, path: '/skills?tab=mcp' })).toBe(
      '/skills?tab=mcp&server=x'
    )
  })

  it('drops empty params rather than emitting a bare `=`', () => {
    expect(resolveHermesOpenPath({ params: { server: '', tab: 'mcp' }, path: '/skills' })).toBe('/skills?tab=mcp')
  })

  it.each([null, undefined, 42 as unknown as string, {} as { href: string }])('returns null for %s', target => {
    expect(resolveHermesOpenPath(target)).toBeNull()
  })

  it('refuses an unsafe path inside a structured target', () => {
    expect(resolveHermesOpenPath({ path: '/../secrets' })).toBeNull()
  })
})

describe('pathFromHermesDeepLink', () => {
  it('builds an open path and a plugin-scoped path', () => {
    expect(pathFromHermesDeepLink('open', 'my-page', { item: 'x' })).toBe('/my-page?item=x')
    expect(pathFromHermesDeepLink('index-network', 'intent/1')).toBe('/index-network/intent/1')
  })

  it('refuses a reserved kind and an empty half', () => {
    expect(pathFromHermesDeepLink('plugin', 'install')).toBeNull()
    expect(pathFromHermesDeepLink('', 'x')).toBeNull()
    expect(pathFromHermesDeepLink('open', '')).toBeNull()
  })
})
