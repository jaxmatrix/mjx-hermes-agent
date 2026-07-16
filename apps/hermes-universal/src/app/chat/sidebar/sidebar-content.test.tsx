import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'

// NOTE: import `@/store/session` (→ @/hermes → connection) before `@/store/projects`
// (→ @/store/gateway). Entering the gateway↔connection import cycle via the
// gateway side first leaves connection.ts's top-level `$gatewayState.subscribe`
// reading a TDZ value. The running app always loads connection first (you connect
// before the sidebar mounts), so this ordering only matters under cold test eval.
import { $sessions } from '@/store/session'
import { $pinnedSessionIds, $sidebarAgentsGrouped } from '@/store/layout'
import { $projectScope, $projectTree, ALL_PROJECTS } from '@/store/projects'
import type { SessionInfo } from '@/types/hermes'

import type { SidebarProjectTree } from './projects/model'
import { SidebarScrollBody } from './sidebar-content'

function makeSession(id: string, title: string, startedAt: number): SessionInfo {
  return {
    _lineage_root_id: null,
    ended_at: null,
    id,
    input_tokens: 0,
    is_active: false,
    last_active: startedAt,
    message_count: 1,
    model: null,
    output_tokens: 0,
    preview: null,
    source: null,
    started_at: startedAt,
    title,
    tool_call_count: 0
  }
}

function makeProject(id: string, label: string): SidebarProjectTree {
  return { id, isAuto: false, label, path: null, previewSessions: [], repos: [], sessionCount: 2 }
}

afterEach(() => {
  $sessions.set([])
  $pinnedSessionIds.set([])
  $sidebarAgentsGrouped.set(false)
  $projectTree.set([])
  $projectScope.set(ALL_PROJECTS)
})

describe('SidebarScrollBody — pinned vs recents split', () => {
  it('shows a pinned session under Pinned and the rest under Sessions', () => {
    $sessions.set([makeSession('a', 'Alpha chat', 200), makeSession('b', 'Beta chat', 100)])
    $pinnedSessionIds.set(['a'])

    render(
      <MemoryRouter>
        <SidebarScrollBody />
      </MemoryRouter>
    )

    // Both section labels present, and both rows render.
    expect(screen.getByText('Pinned')).toBeInTheDocument()
    expect(screen.getByText('Sessions')).toBeInTheDocument()
    expect(screen.getByText('Alpha chat')).toBeInTheDocument()
    expect(screen.getByText('Beta chat')).toBeInTheDocument()
  })

  it('shows the pin hint when nothing is pinned', () => {
    $sessions.set([makeSession('b', 'Beta chat', 100)])
    $pinnedSessionIds.set([])

    render(
      <MemoryRouter>
        <SidebarScrollBody />
      </MemoryRouter>
    )

    expect(screen.getByText('Shift-click a chat to pin')).toBeInTheDocument()
  })

  it('renders the projects overview in grouped mode', () => {
    $sidebarAgentsGrouped.set(true)
    $projectScope.set(ALL_PROJECTS)
    $projectTree.set([makeProject('p_1', 'Skunkworks'), makeProject('p_2', 'Website')])

    render(
      <MemoryRouter>
        <SidebarScrollBody />
      </MemoryRouter>
    )

    expect(screen.getByText('Projects')).toBeInTheDocument()
    expect(screen.getByText('Skunkworks')).toBeInTheDocument()
    expect(screen.getByText('Website')).toBeInTheDocument()
  })
})
