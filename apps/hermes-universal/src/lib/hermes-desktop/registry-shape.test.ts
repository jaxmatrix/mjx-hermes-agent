import { describe, expect, it } from 'vitest'

import type { ConnectionView, RegistryView } from '@/store/connections'

import {
  toConnectionConfig,
  toConnectionTarget,
  toDesktopConnection,
  toDesktopRegistry,
  toSaveInput
} from './registry-shape'

// The model mapping, as tables: every row kind into desktop's shape, and every
// desktop form payload back into a Rust save. What a reviewer checks the doc
// comment in `registry-shape.ts` against.

const base = { hasSshKey: false, hasSshPassphrase: false, hasSshPassword: false, headerNames: [], legacy: false }

const LOCAL: ConnectionView = { ...base, hasToken: false, id: 'local', kind: 'local', label: 'This device', order: 0 }

const REMOTE: ConnectionView = {
  ...base,
  authMode: 'token',
  hasToken: true,
  headerNames: ['cf-access-client-id'],
  id: 'home',
  kind: 'remote',
  label: 'Homelab',
  order: 1,
  tokenPreview: 'c0de',
  url: 'https://home.test'
}

const OPEN: ConnectionView = { ...REMOTE, authMode: 'none', hasToken: false, id: 'open', tokenPreview: undefined }

const CLOUD: ConnectionView = {
  ...base,
  hasToken: false,
  id: 'cloud',
  kind: 'cloud',
  label: 'Atlas',
  order: 2,
  org: 'acme',
  url: 'https://atlas.cloud.test'
}

const SSH: ConnectionView = {
  ...base,
  hasSshKey: true,
  hasSshPassphrase: true,
  hasToken: false,
  host: 'box.internal',
  id: 'box',
  keyPath: '~/.ssh/id_ed25519',
  kind: 'ssh',
  label: 'Box',
  legacy: true,
  order: 3,
  port: 2222,
  remoteHermesPath: '/opt/hermes',
  remoteProfile: 'work',
  user: 'deploy'
}

const VIEW: RegistryView = {
  connections: [LOCAL, REMOTE, OPEN, CLOUD, SSH],
  keyringAvailable: false,
  lastUsed: 'home',
  launchMode: 'last-used',
  localSupported: true,
  primary: 'local',
  readOnly: false,
  version: 2
}

describe('a row, in desktop’s shape', () => {
  it.each([
    [
      'local',
      LOCAL,
      { headerNames: [], id: 'local', kind: 'local', label: 'This device', tokenPreview: null, tokenSet: false }
    ],
    [
      'remote (token)',
      REMOTE,
      {
        authMode: 'token',
        headerNames: ['cf-access-client-id'],
        id: 'home',
        kind: 'remote',
        label: 'Homelab',
        tokenPreview: 'c0de',
        tokenSet: true,
        url: 'https://home.test'
      }
    ],
    [
      'remote (none) — desktop has no such mode, so none is said',
      OPEN,
      {
        headerNames: ['cf-access-client-id'],
        id: 'open',
        kind: 'remote',
        label: 'Homelab',
        tokenPreview: null,
        tokenSet: false,
        url: 'https://home.test'
      }
    ],
    [
      'cloud — always a session',
      CLOUD,
      {
        authMode: 'oauth',
        headerNames: [],
        id: 'cloud',
        kind: 'cloud',
        label: 'Atlas',
        org: 'acme',
        tokenPreview: null,
        tokenSet: false,
        url: 'https://atlas.cloud.test'
      }
    ],
    [
      'ssh',
      SSH,
      {
        headerNames: [],
        host: 'box.internal',
        id: 'box',
        keyPath: '~/.ssh/id_ed25519',
        kind: 'ssh',
        label: 'Box',
        port: 2222,
        remoteHermesPath: '/opt/hermes',
        remoteProfile: 'work',
        tokenPreview: null,
        tokenSet: false,
        user: 'deploy'
      }
    ]
  ])('%s', (_name, row, expected) => {
    expect(toDesktopConnection(row)).toEqual(expected)
  })

  it('never carries an address for a tunnelled row, even one Rust were to send', () => {
    const tunnelled = { ...SSH, url: 'http://127.0.0.1:41873' }
    const local = { ...LOCAL, url: 'http://127.0.0.1:9119' }

    expect(JSON.stringify([toDesktopConnection(tunnelled), toDesktopConnection(local)])).not.toContain('127.0.0.1')
  })

  it('carries a token as a flag and four characters, and universal’s own fields not at all', () => {
    const shaped = toDesktopConnection({ ...REMOTE, ...({ token: 's3cret-token' } as object) })

    expect(JSON.stringify(shaped)).not.toContain('s3cret-token')
    expect(Object.keys(toDesktopConnection(SSH))).not.toEqual(
      expect.arrayContaining(['order', 'legacy', 'hasSshKey', 'hasSshPassphrase', 'hasSshPassword', 'hasToken'])
    )
  })
})

describe('the registry, in desktop’s shape', () => {
  it('keeps the pointers, and never offers a plaintext token store', () => {
    expect(toDesktopRegistry(VIEW)).toEqual({
      connections: VIEW.connections.map(toDesktopConnection),
      lastUsed: 'home',
      launchMode: 'last-used',
      primary: 'local',
      // Even with no keyring: Rust refuses the save rather than fall back.
      secureTokenStorage: true,
      version: 2
    })
  })
})

describe('a save from desktop’s form', () => {
  it('sends an SSH row’s composite host and key path, and nothing it does not show', () => {
    // What `connections-registry.tsx` builds: never user, port or remote profile.
    const save = toSaveInput(
      { host: 'deploy@box.internal:2222', id: 'box', keyPath: undefined, kind: 'ssh', label: 'Box 2' },
      SSH
    )

    expect(save).toEqual({ host: 'deploy@box.internal:2222', id: 'box', kind: 'ssh', label: 'Box 2' })
    // Rust keeps every field an input omits (`normalize_connection_input`).
    expect(Object.keys(save)).not.toEqual(
      expect.arrayContaining([
        'user',
        'port',
        'remoteHermesPath',
        'remoteProfile',
        'passphrase',
        'password',
        'privateKeyPem'
      ])
    )
  })

  it('never changes a row’s kind, whatever the form says', () => {
    expect(toSaveInput({ id: 'box', kind: 'remote', label: 'Box', url: 'https://evil.test' }, SSH)).toEqual({
      id: 'box',
      kind: 'ssh',
      label: 'Box'
    })
    expect(toSaveInput({ id: 'local', kind: 'ssh', host: 'x', label: 'Mine' }, LOCAL)).toEqual({
      id: 'local',
      kind: 'local',
      label: 'Mine'
    })
  })

  it('keeps a cloud row’s org when the form does not name one', () => {
    const save = toSaveInput(
      { authMode: 'oauth', headers: {}, id: 'cloud', kind: 'cloud', label: 'Atlas', url: CLOUD.url },
      CLOUD
    )

    expect(save).toEqual({ authMode: 'oauth', headers: {}, id: 'cloud', kind: 'cloud', label: 'Atlas', url: CLOUD.url })
    expect('org' in save).toBe(false)
  })

  it('passes a typed token through write-only, and drops the plaintext opt-in', () => {
    const save = toSaveInput(
      {
        allowPlainTextToken: true,
        authMode: 'token',
        id: 'home',
        kind: 'remote',
        label: 'Homelab',
        token: ' n3w ',
        url: REMOTE.url
      },
      REMOTE
    )

    expect(save).toEqual({
      authMode: 'token',
      id: 'home',
      kind: 'remote',
      label: 'Homelab',
      token: 'n3w',
      url: REMOTE.url
    })
  })

  it('leaves a stored token alone when none is typed', () => {
    expect(
      'token' in toSaveInput({ authMode: 'token', id: 'home', kind: 'remote', label: 'H', url: REMOTE.url }, REMOTE)
    ).toBe(false)
  })

  it('does not stamp `token` on a row that asks for none: that is the form’s default, not a decision', () => {
    const rename = { authMode: 'token' as const, id: 'open', kind: 'remote' as const, label: 'Renamed', url: OPEN.url }

    expect('authMode' in toSaveInput(rename, OPEN)).toBe(false)
    // A new row likewise: stamped `none` by Rust and proven at its first dial.
    expect(
      'authMode' in toSaveInput({ authMode: 'token', kind: 'remote', label: 'New', url: 'https://new.test' })
    ).toBe(false)
    // A decision is a decision: a typed token, or OAuth.
    expect(toSaveInput({ ...rename, token: 'abc' }, OPEN).authMode).toBe('token')
    expect(toSaveInput({ ...rename, authMode: 'oauth' }, OPEN).authMode).toBe('oauth')
  })

  it('keeps a header’s stored secret on `null`, replaces it on a value, deletes it on an empty one', () => {
    const save = toSaveInput(
      {
        headers: { 'cf-access-client-id': null, 'cf-access-client-secret': 'fresh', 'x-gone': '' },
        id: 'home',
        kind: 'remote',
        label: 'Homelab',
        url: REMOTE.url
      },
      REMOTE
    )

    expect(save.headers).toEqual({ 'cf-access-client-id': null, 'cf-access-client-secret': 'fresh', 'x-gone': '' })
  })

  it('hands Rust an id the view does not know, to refuse in its own words', () => {
    expect(toSaveInput({ id: 'ghost', kind: 'remote', label: 'Ghost', url: 'https://g.test' }).id).toBe('ghost')
  })
})

describe('the v1 config, read from a row', () => {
  const blank = {
    cloudOrg: '',
    envOverride: false,
    mode: 'local',
    profile: null,
    remoteAuthMode: 'token',
    remoteOauthConnected: false,
    remoteTokenPlainText: false,
    remoteTokenPreview: null,
    remoteTokenSet: false,
    remoteUrl: '',
    secureTokenStorage: true,
    sshHost: '',
    sshKeyPath: '',
    sshPort: null,
    sshRemoteHermesPath: '',
    sshRemoteProfile: '',
    sshUser: ''
  }

  it.each([
    ['no row', undefined, {}, blank],
    ['local', LOCAL, {}, blank],
    [
      'remote (token)',
      REMOTE,
      {},
      { ...blank, mode: 'remote', remoteTokenPreview: 'c0de', remoteTokenSet: true, remoteUrl: 'https://home.test' }
    ],
    [
      'remote (none) reads as the token form, with no token',
      OPEN,
      {},
      { ...blank, mode: 'remote', remoteUrl: 'https://home.test' }
    ],
    [
      'cloud, signed in',
      CLOUD,
      { oauthConnected: true },
      {
        ...blank,
        cloudOrg: 'acme',
        mode: 'cloud',
        remoteAuthMode: 'oauth',
        remoteOauthConnected: true,
        remoteUrl: 'https://atlas.cloud.test'
      }
    ],
    [
      'ssh',
      SSH,
      {},
      {
        ...blank,
        mode: 'ssh',
        sshHost: 'box.internal',
        sshKeyPath: '~/.ssh/id_ed25519',
        sshPort: 2222,
        sshRemoteHermesPath: '/opt/hermes',
        sshRemoteProfile: 'work',
        sshUser: 'deploy'
      }
    ]
  ] as const)('%s', (_name, row, facts, expected) => {
    expect(toConnectionConfig(row, facts)).toEqual(expected)
  })

  it('never reports a token row as signed in, and echoes a named profile as local', () => {
    expect(toConnectionConfig(REMOTE, { oauthConnected: true }).remoteOauthConnected).toBe(false)
    expect(toConnectionConfig(undefined, { profile: 'work' })).toEqual({ ...blank, profile: 'work' })
  })
})

describe('a v1 payload, as the target a row is found by', () => {
  it.each([
    [{ mode: 'local' }, { kind: 'local' }],
    [
      { mode: 'remote', remoteAuthMode: 'token', remoteToken: ' abc ', remoteUrl: ' https://home.test ' },
      { authMode: 'token', kind: 'remote', token: 'abc', url: 'https://home.test' }
    ],
    // An OAuth gateway takes no token, whatever is still in the box.
    [
      { mode: 'remote', remoteAuthMode: 'oauth', remoteToken: 'stale', remoteUrl: 'https://gated.test' },
      { authMode: 'oauth', kind: 'remote', url: 'https://gated.test' }
    ],
    [
      {
        cloudName: 'Atlas',
        cloudOrg: 'acme',
        mode: 'cloud',
        remoteAuthMode: 'oauth',
        remoteUrl: 'https://atlas.cloud.test'
      },
      { authMode: 'oauth', kind: 'cloud', label: 'Atlas', org: 'acme', url: 'https://atlas.cloud.test' }
    ],
    [
      {
        mode: 'ssh',
        sshHost: 'box.internal',
        sshKeyPath: '',
        sshPort: null,
        sshRemoteHermesPath: '',
        sshRemoteProfile: '',
        sshUser: 'deploy'
      },
      // Blank and null are "not named": Rust keeps the row's.
      { host: 'box.internal', kind: 'ssh', user: 'deploy' }
    ]
  ] as const)('%j', (input, expected) => {
    expect(toConnectionTarget(input)).toEqual(expected)
  })
})
