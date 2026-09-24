import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { $connection } from '@/store/session'
import type { SessionInfo, SessionMessage } from '@/types/hermes'

import { artifactImageSrc, collectArtifactsForSession } from './artifact-utils'

const getAllSessionMessages = vi.fn()
const listAllProfileSessions = vi.fn()
const saveGatewayFile = vi.fn(async () => ({ saved: true }))

vi.mock('@/hermes', async importOriginal => ({
  getApiRequestConnection: () => null,
  setApiRequestProfile: vi.fn(),
  getApiRequestProfile: () => 'default',
  ...((await importOriginal()) as Record<string, unknown>),
  getAllSessionMessages: (...args: unknown[]) => getAllSessionMessages(...args),
  listAllProfileSessions: (...args: unknown[]) => listAllProfileSessions(...args)
}))

const { ArtifactsView } = await import('./index')

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    ended_at: null,
    id: 'session-1',
    input_tokens: 0,
    is_active: false,
    last_active: 1000,
    message_count: 1,
    model: null,
    output_tokens: 0,
    preview: null,
    source: null,
    started_at: 1000,
    title: 'Session',
    tool_call_count: 0,
    ...overrides
  }
}

afterEach(() => {
  cleanup()
  $connection.set(null)
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('collectArtifactsForSession', () => {
  it('indexes plain https links from assistant text', () => {
    const artifacts = collectArtifactsForSession(makeSession(), [
      {
        content: 'Reference: https://example.com/docs/getting-started',
        role: 'assistant',
        timestamp: 2000
      }
    ])

    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]).toMatchObject({
      href: 'https://example.com/docs/getting-started',
      kind: 'link',
      value: 'https://example.com/docs/getting-started'
    })
  })

  // Passive tool JSON is intentionally NOT indexed — only producer tools /
  // explicit artifact keys are. Full matrix lives in index.test.ts.
  it('does not index http links present in passive tool JSON payloads', () => {
    const messages: SessionMessage[] = [
      {
        content: JSON.stringify({ source_url: 'https://example.com/changelog/latest' }),
        role: 'tool',
        timestamp: 3000,
        tool_name: 'web_search'
      }
    ]

    expect(collectArtifactsForSession(makeSession({ id: 'session-2' }), messages)).toHaveLength(0)
  })

  it('resolves a gateway-local image through the authenticated fs bridge', async () => {
    const api = vi.fn(async ({ path }: { path: string }) => {
      if (path.startsWith('/api/fs/read-data-url?')) {
        return { dataUrl: 'data:image/jpeg;base64,Ynl0ZXM=' }
      }

      throw new Error(`unexpected path ${path}`)
    })

    // Stub hermesDesktop only — replacing `window` wholesale drops jsdom APIs
    // (rAF, addEventListener) that ArtifactsView and tooltips need.
    vi.stubGlobal('hermesDesktop', { api })
    $connection.set({ baseUrl: 'https://gw', mode: 'remote', token: 'secret' } as never)

    const path = '/Users/me/.hermes/skills/x/images/step.jpeg'

    await expect(artifactImageSrc(path)).resolves.toBe('data:image/jpeg;base64,Ynl0ZXM=')
    expect(api).toHaveBeenCalledWith({
      path: '/api/fs/read-data-url?path=%2FUsers%2Fme%2F.hermes%2Fskills%2Fx%2Fimages%2Fstep.jpeg'
    })
  })

  it('passes an http artifact through untouched', async () => {
    const href = 'https://example.com/diagram.png'

    await expect(artifactImageSrc(href)).resolves.toBe(href)
  })
})

/**
 * Failure-tolerance: one unreadable transcript must not blank the whole gallery.
 * Serial load ordering is covered in index.test.ts (`loadArtifactsForSessions`).
 */
describe('ArtifactsView transcript loading', () => {
  const session = (id: string): SessionInfo => makeSession({ id, title: id })

  it('keeps the artifacts of the sessions that loaded when one transcript fails', async () => {
    listAllProfileSessions.mockResolvedValue({ sessions: [session('bad'), session('good')] })
    getAllSessionMessages.mockImplementation(async (id: string) => {
      if (id === 'bad') {
        throw new Error('transcript unreadable')
      }

      return {
        messages: [
          { content: 'Reference: https://example.com/survivor', role: 'assistant', timestamp: 2000 }
        ] satisfies SessionMessage[]
      }
    })

    render(
      <MemoryRouter>
        <ArtifactsView />
      </MemoryRouter>
    )

    await waitFor(() => expect(screen.getByText(/example\.com\/survivor/)).toBeTruthy())
    expect(getAllSessionMessages).toHaveBeenCalledTimes(2)
  })
})

/**
 * Image cards expose Chat only — open/download lives on the file table cells
 * (see remote-open.test.tsx). Title text is not an activation target.
 */
describe('ArtifactImageCard', () => {
  const imageSession = () => {
    listAllProfileSessions.mockResolvedValue({ sessions: [makeSession({ id: 'shots', title: 'Shots' })] })
    getAllSessionMessages.mockResolvedValue({
      messages: [
        { content: '![step one](/Users/me/out/step.png)', role: 'assistant', timestamp: 2000 }
      ] satisfies SessionMessage[]
    })
  }

  it('renders the image label and navigates Chat without starting a download', async () => {
    imageSession()
    vi.stubGlobal('hermesDesktop', { saveGatewayFile })
    $connection.set({
      baseUrl: 'https://gw',
      mode: 'remote',
      token: 'secret',
      connectionId: 'remote-fixture',
      profile: 'default'
    } as never)

    render(
      <MemoryRouter initialEntries={['/artifacts']}>
        <Routes>
          <Route element={<ArtifactsView />} path="/artifacts" />
          <Route element={<div>chat route</div>} path="*" />
        </Routes>
      </MemoryRouter>
    )

    expect(await screen.findByText('step.png')).toBeTruthy()

    fireEvent.click(await screen.findByRole('button', { name: 'Chat' }))

    expect(await screen.findByText('chat route')).toBeTruthy()
    expect(saveGatewayFile).not.toHaveBeenCalled()
  })
})
