import { describe, expect, it } from 'vitest'

import { resolvePluginSourceLinks } from './plugin-source-urls'

describe('resolvePluginSourceLinks', () => {
  it('expands owner/repo into a clone url and a browse page', () => {
    expect(resolvePluginSourceLinks('jaxmatrix/hermes-plugin')).toEqual({
      browseUrl: 'https://github.com/jaxmatrix/hermes-plugin',
      gitUrl: 'https://github.com/jaxmatrix/hermes-plugin.git',
      insecure: false,
      subdir: null
    })
  })

  it('keeps a monorepo subdir and points the browse link at it', () => {
    expect(resolvePluginSourceLinks('owner/repo/packages/thing')).toMatchObject({
      browseUrl: 'https://github.com/owner/repo/tree/HEAD/packages/thing',
      gitUrl: 'https://github.com/owner/repo.git',
      subdir: 'packages/thing'
    })
  })

  it('reads a GitHub file-browser url, which is not a clone url', () => {
    expect(resolvePluginSourceLinks('https://github.com/owner/repo/tree/main/plugins/kanban')).toMatchObject({
      gitUrl: 'https://github.com/owner/repo.git',
      subdir: 'plugins/kanban'
    })
  })

  it('reads the ssh form', () => {
    expect(resolvePluginSourceLinks('git@github.com:owner/repo.git')).toMatchObject({
      browseUrl: 'https://github.com/owner/repo',
      gitUrl: 'git@github.com:owner/repo.git'
    })
  })

  it('splits a #subdir fragment and a .git/ path off a plain url', () => {
    expect(resolvePluginSourceLinks('https://git.example.com/x/y.git#plugins/a')).toMatchObject({
      gitUrl: 'https://git.example.com/x/y.git',
      subdir: 'plugins/a'
    })
    expect(resolvePluginSourceLinks('https://git.example.com/x/y.git/plugins/b')).toMatchObject({
      gitUrl: 'https://git.example.com/x/y.git',
      subdir: 'plugins/b'
    })
  })

  // The reason this field exists: a `hermes://plugin/install` link can carry
  // any identifier, and a dialog that renders these as ordinary sources is the
  // one that gets someone.
  it.each(['http://git.example.com/x/y.git', 'file:///tmp/whatever.git', 'HTTP://GIT.EXAMPLE.COM/x.git'])(
    'flags %s as insecure',
    identifier => {
      expect(resolvePluginSourceLinks(identifier)).toMatchObject({ insecure: true })
    }
  )

  it('gives an insecure source no browse link to click', () => {
    expect(resolvePluginSourceLinks('http://git.example.com/x/y.git')?.browseUrl).toBeNull()
  })

  it('leaves https and ssh sources secure', () => {
    expect(resolvePluginSourceLinks('owner/repo')?.insecure).toBe(false)
    expect(resolvePluginSourceLinks('ssh://git@example.com/x.git')?.insecure).toBe(false)
  })

  it.each(['', '   ', 'justonesegment'])('returns null for %s', identifier => {
    expect(resolvePluginSourceLinks(identifier)).toBeNull()
  })
})
