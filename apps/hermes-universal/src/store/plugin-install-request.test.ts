import { beforeEach, describe, expect, it } from 'vitest'

import { $pluginInstallRequest, closePluginInstallRequest, openPluginInstallRequest } from './plugin-install-request'

beforeEach(() => {
  $pluginInstallRequest.set(null)
})

describe('the pending request', () => {
  it('stores the repo and optional install switches', () => {
    openPluginInstallRequest({ enable: true, force: false, repo: 'owner/repo' })

    expect($pluginInstallRequest.get()).toEqual({ enable: true, force: false, repo: 'owner/repo' })
  })

  it('supersedes rather than queueing — one question at a time', () => {
    openPluginInstallRequest({ repo: 'a/one' })
    openPluginInstallRequest({ catalogName: 'demo', repo: 'b/two' })

    expect($pluginInstallRequest.get()).toMatchObject({ catalogName: 'demo', repo: 'b/two' })
  })

  it('clears on close', () => {
    openPluginInstallRequest({ repo: 'a/one' })
    closePluginInstallRequest()

    expect($pluginInstallRequest.get()).toBeNull()
  })
})
