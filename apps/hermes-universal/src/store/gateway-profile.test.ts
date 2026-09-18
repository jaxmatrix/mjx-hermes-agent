import { afterEach, describe, expect, it, vi } from 'vitest'

const { sent } = vi.hoisted(() => ({ sent: [] as [string, Record<string, unknown>][] }))

vi.mock('@/gateway', () => ({
  JsonRpcGatewayClient: class {
    close(): void {}
    async connect(): Promise<void> {}
    onAny(): void {}
    onState(): void {}
    async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
      sent.push([method, params])

      return undefined
    }
  }
}))
vi.mock('@/store/gateway-config', () => ({ resolveWsUrl: vi.fn(async () => 'ws://127.0.0.1:1/api/ws') }))
vi.mock('@/transport/tauri-websocket', () => ({ TauriWebSocket: class {} }))
vi.mock('@/contrib/events', () => ({ emitGatewayEvent: vi.fn() }))

import { closeGateway, connectGateway, getGatewayClient, setGatewayRequestProfile } from './gateway-client'

afterEach(() => {
  closeGateway()
  sent.length = 0
})

describe('the primary gateway client', () => {
  // MJXHRM-592: the local and SSH backends run the unified server, so a call made
  // straight on the client (the model picker, completions, one-shot LLM) must
  // name the active profile or it answers for `default`.
  it('names the active profile on calls made straight on the client', async () => {
    const off = setGatewayRequestProfile(() => 'work')

    try {
      await connectGateway({ authMode: 'token', baseUrl: 'http://127.0.0.1:1', mode: 'local' })
      await getGatewayClient()?.request('model.options', {})
      await getGatewayClient()?.request('profiles.list', {})
    } finally {
      off()
    }

    expect(sent).toEqual([
      ['model.options', { profile: 'work' }],
      ['profiles.list', {}]
    ])
  })
})
