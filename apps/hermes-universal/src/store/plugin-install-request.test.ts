import { beforeEach, describe, expect, it, vi } from 'vitest'

import { GatewayRpcError } from '@/gateway/rpc-error'

const installAgentPlugin = vi.fn()

vi.mock('@/lib/gateway-rpc', () => ({ installAgentPlugin: (...args: unknown[]) => installAgentPlugin(...args) }))

import {
  $pluginInstallRequest,
  closePluginInstallRequest,
  installPluginRequest,
  openPluginInstallRequest
} from './plugin-install-request'

beforeEach(() => {
  $pluginInstallRequest.set(null)
  installAgentPlugin.mockReset()
})

describe('the pending request', () => {
  it('keeps the origin, which is what weights the dialog', () => {
    openPluginInstallRequest({ origin: 'deep-link', repo: 'owner/repo' })

    expect($pluginInstallRequest.get()).toEqual({ origin: 'deep-link', repo: 'owner/repo' })
  })

  it('supersedes rather than queueing — one question at a time', () => {
    openPluginInstallRequest({ origin: 'deep-link', repo: 'a/one' })
    openPluginInstallRequest({ origin: 'settings', repo: 'b/two' })

    expect($pluginInstallRequest.get()).toMatchObject({ origin: 'settings', repo: 'b/two' })
  })

  it('clears on close', () => {
    openPluginInstallRequest({ origin: 'settings', repo: 'a/one' })
    closePluginInstallRequest()

    expect($pluginInstallRequest.get()).toBeNull()
  })
})

describe('installPluginRequest', () => {
  it('sends the identifier, the switches and NO client timeout', async () => {
    installAgentPlugin.mockResolvedValue({ name: 'demo', ok: true })

    const outcome = await installPluginRequest({
      enable: false,
      force: true,
      origin: 'settings',
      profile: 'work',
      repo: 'owner/repo'
    })

    expect(outcome).toEqual({ ok: true, result: { name: 'demo', ok: true } })
    expect(installAgentPlugin).toHaveBeenCalledWith(
      { enable: false, force: true, identifier: 'owner/repo', profile: 'work' },
      // A git clone can take minutes; the gateway owns the deadline.
      0
    )
  })

  it.each([
    [4019, 'no-identifier'],
    [5026, 'already-exists'],
    [4017, 'unknown-action']
  ])('maps code %s to %s', async (code, failure) => {
    installAgentPlugin.mockRejectedValue(new GatewayRpcError('backend said so', code))

    await expect(installPluginRequest({ origin: 'settings', repo: 'o/r' })).resolves.toEqual({
      failure,
      message: 'backend said so',
      ok: false
    })
  })

  // The distinction the whole failure enum exists for: a false "install failed"
  // invites a Force retry, and Force is what deletes a good install.
  it.each([
    ['a timeout', new Error('request timed out: plugins.manage')],
    ['a dropped socket', new Error('gateway connection closed')],
    ['an error with no code', new GatewayRpcError('odd', null)]
  ])('reports %s as unreachable, never as a failure', async (_label, error) => {
    installAgentPlugin.mockRejectedValue(error)

    await expect(installPluginRequest({ origin: 'settings', repo: 'o/r' })).resolves.toMatchObject({
      failure: 'unreachable',
      ok: false
    })
  })

  it('never throws, even for a non-Error rejection', async () => {
    installAgentPlugin.mockRejectedValue('a string')

    await expect(installPluginRequest({ origin: 'settings', repo: 'o/r' })).resolves.toMatchObject({
      failure: 'unreachable',
      message: 'a string',
      ok: false
    })
  })
})
