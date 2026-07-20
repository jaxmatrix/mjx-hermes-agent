import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { GatewayEvent } from '@/gateway'

vi.mock('@/store/gateway', async () => {
  const { atom } = await import('@/store/atom')
  return { requestGateway: vi.fn().mockResolvedValue({}), $gatewayState: atom('idle') }
})
import { requestGateway } from '@/store/gateway'

import {
  $approval,
  $clarify,
  $currentCwd,
  $messages,
  $secret,
  $sessionId,
  $sudo,
  handleGatewayEvent,
  resetChat,
  respondSudo
} from './chat'

const ev = (type: string, payload: Record<string, unknown>): GatewayEvent =>
  ({ type, payload } as unknown as GatewayEvent)

beforeEach(() => resetChat())

describe('chat reducer (parts model)', () => {
  it('builds text + reasoning + tool parts from a stream', () => {
    handleGatewayEvent(ev('message.start', {}))
    handleGatewayEvent(ev('message.delta', { text: 'Hel' }))
    handleGatewayEvent(ev('message.delta', { text: 'lo' }))
    handleGatewayEvent(ev('reasoning.delta', { text: 'hmm' }))
    handleGatewayEvent(ev('tool.start', { name: 'grep', tool_id: 't1', args: { q: 'x' } }))
    handleGatewayEvent(ev('tool.complete', { tool_id: 't1', result: 'done' }))
    handleGatewayEvent(ev('message.complete', {}))

    const msgs = $messages.get()
    expect(msgs).toHaveLength(1)
    const m = msgs[0]
    expect(m.role).toBe('assistant')
    expect(m.pending).toBe(false)
    expect(m.parts.find(p => p.type === 'text')).toMatchObject({ type: 'text', text: 'Hello' })
    expect(m.parts.find(p => p.type === 'reasoning')).toMatchObject({ type: 'reasoning', text: 'hmm' })
    expect(m.parts.find(p => p.type === 'tool-call')).toMatchObject({
      type: 'tool-call',
      toolName: 'grep',
      result: 'done'
    })
  })

  it('coalesces consecutive same-channel deltas into one part', () => {
    handleGatewayEvent(ev('message.delta', { text: 'a' }))
    handleGatewayEvent(ev('message.delta', { text: 'b' }))
    const texts = $messages.get()[0].parts.filter(p => p.type === 'text')
    expect(texts).toHaveLength(1)
    expect(texts[0]).toMatchObject({ text: 'ab' })
  })

  it('reasoning.available replaces the tail reasoning part', () => {
    handleGatewayEvent(ev('reasoning.delta', { text: 'draft' }))
    handleGatewayEvent(ev('reasoning.available', { text: 'final' }))
    const reasoning = $messages.get()[0].parts.filter(p => p.type === 'reasoning')
    expect(reasoning).toHaveLength(1)
    expect(reasoning[0]).toMatchObject({ text: 'final' })
  })

  it('routes approval / clarify / sudo / secret to their atoms with request_id', () => {
    handleGatewayEvent(ev('approval.request', { command: 'rm', description: 'danger' }))
    expect($approval.get()).toMatchObject({ command: 'rm', description: 'danger' })
    handleGatewayEvent(ev('clarify.request', { request_id: 'c1', prompt: 'which file?' }))
    expect($clarify.get()).toMatchObject({ requestId: 'c1', prompt: 'which file?' })
    handleGatewayEvent(ev('sudo.request', { request_id: 's1', prompt: 'password?' }))
    expect($sudo.get()).toMatchObject({ requestId: 's1', prompt: 'password?' })
    handleGatewayEvent(ev('secret.request', { request_id: 'x1', env_var: 'API_KEY', prompt: 'key?' }))
    expect($secret.get()).toMatchObject({ requestId: 'x1', envVar: 'API_KEY' })
  })

  it('respondSudo posts sudo.respond with the request_id + password and clears the atom', async () => {
    handleGatewayEvent(ev('sudo.request', { request_id: 's9', prompt: 'pw' }))
    await respondSudo('hunter2')
    expect(requestGateway).toHaveBeenCalledWith('sudo.respond', { request_id: 's9', password: 'hunter2' })
    expect($sudo.get()).toBeNull()
  })
})

describe('session.info cwd tracking', () => {
  it('follows the active session relocating itself', () => {
    $sessionId.set('runtime-1')
    handleGatewayEvent(ev('session.info', { session_id: 'runtime-1', cwd: '/home/me/worktree-b' }))
    expect($currentCwd.get()).toBe('/home/me/worktree-b')
  })

  it('ignores info for a background session', () => {
    $sessionId.set('runtime-1')
    $currentCwd.set('/home/me/project-a')
    handleGatewayEvent(ev('session.info', { session_id: 'other-runtime', cwd: '/home/me/somewhere-else' }))
    expect($currentCwd.get()).toBe('/home/me/project-a')
  })

  it('applies a global broadcast only when no chat is open', () => {
    $sessionId.set(null)
    handleGatewayEvent(ev('session.info', { cwd: '/home/me/default' }))
    expect($currentCwd.get()).toBe('/home/me/default')

    $sessionId.set('runtime-1')
    handleGatewayEvent(ev('session.info', { cwd: '/home/me/other-default' }))
    expect($currentCwd.get()).toBe('/home/me/default')
  })

  it('treats an empty cwd as unknown rather than a detach', () => {
    $sessionId.set('runtime-1')
    $currentCwd.set('/home/me/project-a')
    handleGatewayEvent(ev('session.info', { session_id: 'runtime-1', cwd: '' }))
    expect($currentCwd.get()).toBe('/home/me/project-a')
  })
})
