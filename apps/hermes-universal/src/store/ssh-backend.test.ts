import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn(async () => undefined) }))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))

import { $sshPrompt, addSshPromptAnswerListener, answerActiveSshPrompt, cancelActiveSshPrompt } from './ssh-backend'

const prompt = { attemptId: 'a1', kind: 'passphrase' as const, label: 'Passphrase', promptId: 'p1', secret: true }

beforeEach(() => {
  invoke.mockClear()
  $sshPrompt.set(null)
})

describe('the window-level SSH prompt', () => {
  it('lets a surface keep the answer it did not ask for', async () => {
    const heard: string[] = []
    const off = addSshPromptAnswerListener((asked, answer) => heard.push(`${asked.kind}:${answer}`))

    $sshPrompt.set(prompt)
    await answerActiveSshPrompt('open sesame')
    off()
    $sshPrompt.set(prompt)
    await answerActiveSshPrompt('again')

    expect(heard).toEqual(['passphrase:open sesame'])
    expect(invoke).toHaveBeenCalledWith('ssh_answer_prompt', { answer: 'open sesame', attemptId: 'a1', promptId: 'p1' })
  })

  it('stops the attempt when the question is dismissed', async () => {
    $sshPrompt.set(prompt)
    await cancelActiveSshPrompt()

    expect($sshPrompt.get()).toBeNull()
    expect(invoke).toHaveBeenCalledWith('ssh_cancel', { attemptId: 'a1' })
  })
})
