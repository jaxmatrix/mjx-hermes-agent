/**
 * The Agents overlay's STEER control — the only surface that can redirect a
 * running child.
 *
 * `subagent.steer` answers 200 for every refusal and names which one in
 * `reason`, so the thing worth pinning is that the user is told a different
 * true thing for each: "too late" is a race lost by a hair, "belongs to another
 * chat" will never work from here. And "queued" is not a delivery receipt —
 * a child that finishes before draining the text reports `missed_steer` on its
 * completion frame, which is the only retraction of the promise this control
 * makes (MJXHRM-410).
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { SubagentSteerResult } from '@/lib/gateway-rpc'

const { interruptSubagent, steerSubagent } = vi.hoisted(() => ({
  interruptSubagent: vi.fn(),
  steerSubagent: vi.fn()
}))

vi.mock('@/lib/gateway-rpc', () => ({ interruptSubagent, steerSubagent }))

import { I18nProvider } from '@/i18n'
import { en } from '@/i18n/en'
import { $subagentsBySession, type SubagentProgress } from '@/store/subagents'

import { AgentsView } from './index'

const row = (extra: Partial<SubagentProgress> = {}): SubagentProgress => ({
  id: 'sub-1',
  parentId: null,
  goal: 'research pricing',
  status: 'running',
  taskCount: 1,
  taskIndex: 0,
  startedAt: Date.now(),
  updatedAt: Date.now(),
  filesRead: [],
  filesWritten: [],
  stream: [],
  ...extra
})

const renderAgents = (rows: SubagentProgress[]) => {
  $subagentsBySession.set({ 'runtime-1': rows })

  return render(
    <I18nProvider>
      <AgentsView onClose={() => {}} />
    </I18nProvider>
  )
}

const sendSteer = (text = 'focus on pricing') => {
  fireEvent.click(screen.getByRole('button', { name: en.agents.steer }))
  fireEvent.change(screen.getByPlaceholderText(en.agents.steerPlaceholder), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: en.agents.steerSend }))
}

beforeEach(() => {
  // Every row runs the enter animation on mount; jsdom has no Web Animations.
  Element.prototype.animate ??= (() => ({ cancel: () => {}, finish: () => {} })) as never
  $subagentsBySession.set({})
  steerSubagent.mockReset()
  interruptSubagent.mockReset()
})

describe('agents overlay · steer', () => {
  it('sends the owning session id, not the visible one', async () => {
    steerSubagent.mockResolvedValue({ status: 'queued', subagent_id: 'sub-1', text: 'focus on pricing' })
    renderAgents([row()])

    sendSteer()

    await waitFor(() =>
      expect(steerSubagent).toHaveBeenCalledWith({
        sessionId: 'runtime-1',
        subagentId: 'sub-1',
        text: 'focus on pricing'
      })
    )
    expect(await screen.findByText(en.agents.steerQueued)).toBeTruthy()
  })

  // One "rejected" for five causes leaves the user guessing which of them it
  // was — and whether trying again could ever work.
  it.each([
    ['not_accepting', en.agents.steerRejected],
    ['unknown_subagent', en.agents.steerGone],
    ['no_agent', en.agents.steerGone],
    ['not_owner', en.agents.steerNotOwned],
    ['no_session_authority', en.agents.steerNotOwned],
    ['steer_failed', en.agents.steerRejected]
  ])('explains a %s refusal in its own words', async (reason, expected) => {
    steerSubagent.mockResolvedValue({
      status: 'rejected',
      reason,
      subagent_id: 'sub-1',
      text: 'focus on pricing'
    } satisfies SubagentSteerResult)
    renderAgents([row()])

    sendSteer()

    expect(await screen.findByText(expected)).toBeTruthy()
  })

  // An older gateway sends no `reason` at all, and any value added after this
  // build is equally unknown — both must still say something.
  it('falls back to the generic refusal when the gateway names no reason', async () => {
    steerSubagent.mockResolvedValue({ status: 'rejected', subagent_id: 'sub-1', text: 'focus on pricing' })
    renderAgents([row()])

    sendSteer()

    expect(await screen.findByText(en.agents.steerRejected)).toBeTruthy()
  })

  it('separates a transport failure from a refusal', async () => {
    steerSubagent.mockRejectedValue(new Error('socket down'))
    renderAgents([row()])

    sendSteer()

    expect(await screen.findByText(en.agents.steerFailed)).toBeTruthy()
  })

  // The row is terminal by the time the gateway knows, so this is the last
  // word the user gets about a correction the subagent never saw.
  it('retracts a queued steer the child never delivered', () => {
    renderAgents([row({ status: 'completed', missedSteer: 'focus on pricing' })])

    expect(screen.getByText(en.agents.steerMissed('focus on pricing'))).toBeTruthy()
  })

  it('says nothing about a steer for a child that delivered everything', () => {
    renderAgents([row({ status: 'completed' })])

    expect(screen.queryByText(/steer never landed/i)).toBeNull()
    // ...and a settled row offers no steer control at all.
    expect(screen.queryByRole('button', { name: en.agents.steer })).toBeNull()
  })
})

/**
 * STOP — the other half of the control the overlay never had.
 *
 * `subagent.interrupt` answers 200 with `found: false` when the id resolves to
 * nothing (the child already exited, or it belongs to a delegation this gateway
 * does not own), exactly the way steer answers `rejected`. Reporting only the
 * happy path would make the button look like it worked every single time.
 */
describe('agents overlay · stop', () => {
  it('ends the child the row is showing', async () => {
    interruptSubagent.mockResolvedValue({ found: true, subagent_id: 'sub-1' })
    // Two live children, so "the id the row shows" is a real choice and not the
    // only id on screen. `startedAt` pins the render order the tree sorts by.
    renderAgents([row({ id: 'sub-1', startedAt: 1 }), row({ goal: 'other work', id: 'sub-2', startedAt: 2 })])

    fireEvent.click(screen.getAllByRole('button', { name: en.agents.stop })[0]!)

    await waitFor(() => expect(interruptSubagent).toHaveBeenCalledWith({ subagentId: 'sub-1' }))
    expect(await screen.findByText(en.agents.stopRequested)).toBeTruthy()
  })

  it('says so when there was nothing left to stop', async () => {
    interruptSubagent.mockResolvedValue({ found: false, subagent_id: 'sub-1' })
    renderAgents([row()])

    fireEvent.click(screen.getByRole('button', { name: en.agents.stop }))

    expect(await screen.findByText(en.agents.steerGone)).toBeTruthy()
    expect(screen.queryByText(en.agents.stopRequested)).toBeNull()
  })

  it('separates a transport failure from a miss', async () => {
    interruptSubagent.mockRejectedValue(new Error('socket down'))
    renderAgents([row()])

    fireEvent.click(screen.getByRole('button', { name: en.agents.stop }))

    expect(await screen.findByText(en.agents.steerFailed)).toBeTruthy()
  })

  it('offers no stop for a settled row', () => {
    renderAgents([row({ status: 'completed' })])

    expect(screen.queryByRole('button', { name: en.agents.stop })).toBeNull()
  })
})

/**
 * Truncation and worktree state — facts the parent MODEL's tool result has
 * carried for a while and the event stream never did (MJXHRM-459).
 */
describe('agents overlay · truncation and worktree', () => {
  it('marks a child that ran out of steps, even though it says completed', () => {
    renderAgents([row({ status: 'completed', truncated: true })])

    expect(screen.getByText(en.agents.truncatedNotice)).toBeTruthy()
  })

  it('says nothing about truncation for a child that finished its work', () => {
    renderAgents([row({ status: 'completed', truncated: false })])

    expect(screen.queryByText(en.agents.truncatedNotice)).toBeNull()
  })

  it('names the isolated checkout and what it holds', () => {
    renderAgents([
      row({
        status: 'completed',
        worktree: { branch: 'hermes/sub-1', commits: 3, dirty: true, path: '/tmp/wt/sub-1', pruned: false }
      })
    ])

    expect(screen.getByText('/tmp/wt/sub-1')).toBeTruthy()
    expect(screen.getByText(new RegExp(en.agents.worktreeCommits(3)))).toBeTruthy()
    expect(screen.getByText(new RegExp(en.agents.worktreeDirty))).toBeTruthy()
  })

  it('reports a pruned checkout as gone rather than as empty work', () => {
    renderAgents([
      row({
        status: 'completed',
        worktree: { branch: 'hermes/sub-1', commits: 0, dirty: false, path: '/tmp/wt/sub-1', pruned: true }
      })
    ])

    expect(screen.getByText(en.agents.worktreePruned)).toBeTruthy()
    expect(screen.queryByText(new RegExp(en.agents.worktreeCommits(0)))).toBeNull()
  })

  // The payload's `commits: 0` / `dirty: false` are DEFAULTS when the git
  // probes failed, so printing "0 commits" from them states the one conclusion
  // the gateway's own note warns against.
  it('refuses to report an unmeasured checkout as having no commits', () => {
    renderAgents([
      row({
        status: 'completed',
        worktree: {
          branch: 'hermes/sub-1',
          commits: 0,
          dirty: false,
          inspectionFailed: true,
          path: '/tmp/wt/sub-1',
          pruned: false
        }
      })
    ])

    expect(screen.getByText(en.agents.worktreeUnknown)).toBeTruthy()
    expect(screen.queryByText(new RegExp(en.agents.worktreeCommits(0)))).toBeNull()
  })
})
