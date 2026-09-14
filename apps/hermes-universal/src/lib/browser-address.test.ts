import { describe, expect, it } from 'vitest'

import { normalizeBrowserAddress } from './browser-address'

describe('normalizeBrowserAddress', () => {
  it('passes an http or https url through', () => {
    expect(normalizeBrowserAddress('https://example.com/a?b=1#c')).toBe('https://example.com/a?b=1#c')
    expect(normalizeBrowserAddress('http://example.com/')).toBe('http://example.com/')
  })

  it('gives a bare host https and a loopback host http', () => {
    // A loopback dev server has no certificate and nothing on 443, so guessing
    // https there is a guaranteed failure rather than a safer default.
    expect(normalizeBrowserAddress('example.com')).toBe('https://example.com/')
    expect(normalizeBrowserAddress('localhost')).toBe('http://localhost/')
    expect(normalizeBrowserAddress('127.0.0.1')).toBe('http://127.0.0.1/')
  })

  it('reads host:port as a host and a port, not as a scheme', () => {
    // Dropping the host:port branch turns this red: `localhost:5173` matches
    // `scheme:` to any naive parser, and so does `example.com:8080`.
    expect(normalizeBrowserAddress('localhost:5173')).toBe('http://localhost:5173/')
    expect(normalizeBrowserAddress('example.com:8080')).toBe('https://example.com:8080/')
    expect(normalizeBrowserAddress('127.0.0.1:3000/app')).toBe('http://127.0.0.1:3000/app')
  })

  it('refuses every scheme that could make the guest a local origin', () => {
    // The narrowing versus the Electron desktop app, which allowed all of these.
    for (const raw of [
      'file:///etc/passwd',
      'data:text/html,<script>1</script>',
      'javascript:alert(1)',
      'view-source:https://example.com',
      'blob:https://example.com/abc',
      'chrome://settings',
      'tauri://localhost/index.html',
      'hermes-artifact://localhost/abc'
    ]) {
      expect(normalizeBrowserAddress(raw), raw).toBeNull()
    }
  })

  it('allows about:blank and nothing else in the about: space', () => {
    expect(normalizeBrowserAddress('about:blank')).toBe('about:blank')
    expect(normalizeBrowserAddress('ABOUT:BLANK')).toBe('about:blank')
    expect(normalizeBrowserAddress('about:config')).toBeNull()
  })

  it('returns null for hermes:// so the caller can route the APP instead', () => {
    // The guest must never navigate there; the bar checks the deep-link table
    // BEFORE calling this.
    expect(normalizeBrowserAddress('hermes://open/settings/model')).toBeNull()
  })

  it('refuses a PATH — that is the file tab\'s job, not the guest\'s', () => {
    // `new URL('https:///repo/x')` reads `repo` as the HOST, so the parser
    // cannot be the guard here.
    for (const raw of ['/repo/src/main.tsx', './rel.md', '../up.md', '~/notes.md', 'C:\\work\\a.txt']) {
      expect(normalizeBrowserAddress(raw), raw).toBeNull()
    }
  })

  it('trims whitespace and refuses what is left when there is nothing', () => {
    expect(normalizeBrowserAddress('  https://example.com  ')).toBe('https://example.com/')
    expect(normalizeBrowserAddress('   ')).toBeNull()
    expect(normalizeBrowserAddress('')).toBeNull()
    expect(normalizeBrowserAddress('https://')).toBeNull()
  })
})
