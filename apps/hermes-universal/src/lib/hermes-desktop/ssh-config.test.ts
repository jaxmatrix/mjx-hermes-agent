import { beforeEach, describe, expect, it, vi } from 'vitest'

const ssh = vi.hoisted(() => ({ listSshConfigHosts: vi.fn(), resolveSshHost: vi.fn() }))

vi.mock('@/store/ssh-backend', () => ssh)

import { sshConfigBridge as bridge } from './ssh-config'

beforeEach(() => vi.clearAllMocks())

describe('the SSH config reader', () => {
  it('suggests the aliases Rust read from ~/.ssh/config', async () => {
    ssh.listSshConfigHosts.mockResolvedValueOnce(['box', 'studio'])

    expect(await bridge.sshConfigHosts()).toEqual({ hosts: ['box', 'studio'] })
  })

  it('resolves an alias into desktop’s four fields, null where the config says nothing', async () => {
    ssh.resolveSshHost.mockResolvedValueOnce({ hostname: 'box.internal', port: 2222, unsupported: ['ProxyJump'] })

    expect(await bridge.sshResolveHost(' box ')).toEqual({
      hostname: 'box.internal',
      identityFile: null,
      port: 2222,
      user: null
    })
    expect(ssh.resolveSshHost).toHaveBeenCalledExactlyOnceWith('box')
  })

  it('asks for a host in Electron’s words, and never repeats Rust’s about one', async () => {
    await expect(bridge.sshResolveHost('  ')).rejects.toThrow('SSH host is required.')

    ssh.resolveSshHost.mockRejectedValueOnce({ kind: 'unknown', message: 'could not read config for box.internal' })

    const failed = await bridge.sshResolveHost('box.internal').catch(error => error)

    expect(failed).toBeInstanceOf(Error)
    expect(failed.message).not.toContain('box.internal')
  })
})
