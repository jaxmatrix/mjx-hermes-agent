import type * as AssistantUI from '@assistant-ui/react'
import type { ToolCallMessagePartProps } from '@assistant-ui/react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type * as Hermes from '@/hermes'
import { I18nProvider } from '@/i18n'
import type * as GatewayRpc from '@/lib/gateway-rpc'
import type * as McpServers from '@/lib/mcp-servers'
import type * as Notifications from '@/store/notifications'

// The live card asks assistant-ui whether its message is still streaming. There
// is no runtime in a unit test, so drive it from here and leave the rest of the
// module intact. MUTABLE: the stopped-mid-prompt branch is the one that keeps a
// dead panel's buttons from running a real install.
const aui = vi.hoisted(() => ({ messageRunning: true }))

vi.mock('@assistant-ui/react', async importActual => {
  const actual = await importActual<typeof AssistantUI>()

  return { ...actual, useAuiState: () => aui.messageRunning }
})

// Partial mocks: only the network/IPC seams are replaced, so the card's own
// branching (which action, catalog vs directory, rollback) stays under test.
vi.mock('@/lib/gateway-rpc', async importActual => {
  const actual = await importActual<typeof GatewayRpc>()

  return { ...actual, respondMcpSetup: vi.fn().mockResolvedValue({ status: 'ok' }) }
})

vi.mock('@/store/gateway', async () => {
  const { atom } = await import('@/store/atom')

  return {
    addGatewayEventListener: () => () => {},
    requestGateway: vi.fn().mockResolvedValue({}),
    $gatewayState: atom('open')
  }
})

vi.mock('@/hermes', async importActual => {
  const actual = await importActual<typeof Hermes>()

  return {
    ...actual,
    authMcpServer: vi.fn(),
    cancelMcpOAuthFlow: vi.fn().mockResolvedValue({ ok: true, status: 'expired' }),
    getActionStatus: vi.fn(),
    getMcpCatalog: vi.fn().mockResolvedValue({ entries: [], diagnostics: [] }),
    getMcpOAuthFlow: vi.fn(),
    installMcpCatalogEntry: vi.fn().mockResolvedValue({ ok: true }),
    setMcpServerEnabled: vi.fn().mockResolvedValue({ ok: true })
  }
})

vi.mock('@/lib/mcp-servers', async importActual => {
  const actual = await importActual<typeof McpServers>()

  return {
    ...actual,
    removeMcpServerEntry: vi.fn().mockResolvedValue(undefined),
    writeMcpServerEntry: vi.fn().mockResolvedValue({})
  }
})

vi.mock('@/lib/external-link', () => ({ openExternalLink: vi.fn().mockResolvedValue(undefined) }))

vi.mock('@/store/notifications', async importActual => {
  const actual = await importActual<typeof Notifications>()

  return { ...actual, notify: vi.fn(), notifyError: vi.fn() }
})

import {
  authMcpServer,
  getActionStatus,
  getMcpCatalog,
  getMcpOAuthFlow,
  installMcpCatalogEntry,
  setMcpServerEnabled
} from '@/hermes'
import { respondMcpSetup } from '@/lib/gateway-rpc'
import { removeMcpServerEntry, writeMcpServerEntry } from '@/lib/mcp-servers'
import { requestGateway } from '@/store/gateway'
import { notifyError } from '@/store/notifications'
import { sessionMcpSetupRequest, setSessionMcpSetup } from '@/store/prompts'
import { seedActiveSession } from '@/test-sessions'

import { McpSetupTool } from './mcp-setup-tool'

const respond = vi.mocked(respondMcpSetup)

afterEach(() => {
  cleanup()
  seedActiveSession('sess-1')
  setSessionMcpSetup('sess-1', null)
  aui.messageRunning = true
  vi.clearAllMocks()
  respond.mockResolvedValue({ status: 'ok' })
  vi.mocked(requestGateway).mockResolvedValue({} as never)
  vi.mocked(getMcpCatalog).mockResolvedValue({ entries: [], diagnostics: [] })
  vi.mocked(setMcpServerEnabled).mockResolvedValue({ ok: true })
  vi.mocked(installMcpCatalogEntry).mockResolvedValue({ ok: true })
  vi.mocked(writeMcpServerEntry).mockResolvedValue({})
})

const park = (over: Partial<{ action: 'authorize' | 'enable' | 'install'; reason: string; server: string }> = {}) => {
  seedActiveSession('sess-1')
  setSessionMcpSetup('sess-1', {
    action: 'install',
    reason: 'To read the ticket you linked',
    requestId: 'req-1',
    server: 'linear',
    ...over
  })
}

function setupProps(
  args: ToolCallMessagePartProps['args'],
  result?: ToolCallMessagePartProps['result']
): ToolCallMessagePartProps {
  return {
    addResult: vi.fn(),
    args,
    argsText: JSON.stringify(args),
    isError: false,
    respondToApproval: vi.fn(),
    result,
    resume: vi.fn(),
    status: result === undefined ? { type: 'running' } : { type: 'complete' },
    toolCallId: 'req-1',
    toolName: 'setup_mcp',
    type: 'tool-call'
  } as unknown as ToolCallMessagePartProps
}

const renderCard = (ui: ReactNode) => render(<I18nProvider>{ui}</I18nProvider>)

/** Let the card's own respond continuation run before asserting on it. */
async function settle() {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

describe('McpSetupTool — the consent card', () => {
  it('shows what will be installed: the server, the reason, and the endpoint', () => {
    park()
    renderCard(<McpSetupTool {...setupProps({ server: 'linear' })} />)

    expect(screen.getByText('Add the Linear MCP server?')).toBeTruthy()
    expect(screen.getByText('To read the ticket you linked')).toBeTruthy()
    // The capability disclosure — the exact endpoint that will be contacted,
    // from the hosted-remote directory. Asserting the URL, not "some text".
    expect(screen.getByText('https://mcp.linear.app/mcp')).toBeTruthy()
  })

  // `tool.start` fires a tick before `mcp.setup.request`. A button clicked in
  // that window would have no request_id to answer with.
  it('holds the buttons until the request that carries the id has landed', () => {
    seedActiveSession('sess-1')
    renderCard(<McpSetupTool {...setupProps({ server: 'linear' })} />)

    expect(screen.queryByRole('button', { name: /Install/ })).toBeNull()
  })

  it('answers declined with the request id of the card that raised it', async () => {
    park()
    renderCard(<McpSetupTool {...setupProps({ server: 'linear' })} />)

    fireEvent.click(screen.getByRole('button', { name: /Not now/ }))
    await settle()

    expect(respond).toHaveBeenCalledWith('req-1', { server: 'linear', status: 'declined' })
    expect(sessionMcpSetupRequest('sess-1').get()).toBeNull()
  })

  // Seeded to disagree: the store's request id differs from the tool row's
  // `toolCallId`, so an implementation reading the row would send 'req-1'.
  it('takes the id from the store, never from the tool row', async () => {
    park()
    setSessionMcpSetup('sess-1', { action: 'install', reason: '', requestId: 'req-live', server: 'linear' })
    renderCard(<McpSetupTool {...setupProps({ server: 'linear' })} />)

    fireEvent.click(screen.getByRole('button', { name: /Not now/ }))
    await settle()

    expect(respond).toHaveBeenCalledWith('req-live', expect.anything())
  })

  it('enables a configured server and reports enabled', async () => {
    park({ action: 'enable' })
    renderCard(<McpSetupTool {...setupProps({ server: 'linear' })} />)

    expect(screen.getByText('Enable the Linear MCP server?')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Enable/ }))
    await settle()

    expect(setMcpServerEnabled).toHaveBeenCalledWith('linear', true)
    expect(respond).toHaveBeenCalledWith('req-1', { server: 'linear', status: 'enabled' })
  })

  // Not just "called first" — call ORDER is the same whether or not the reload
  // is awaited, so that assertion cannot fail. What matters is that the reload
  // has COMPLETED: the agent must not resume holding a tool snapshot that lacks
  // the server it was just told is ready. So hold the reload open and prove the
  // respond has not gone out yet.
  it('waits for the live session to reload before it unblocks the tool', async () => {
    park({ action: 'enable' })

    let finishReload = () => {}
    vi.mocked(requestGateway).mockImplementation(
      () => new Promise(resolve => (finishReload = () => resolve({} as never)))
    )

    renderCard(<McpSetupTool {...setupProps({ server: 'linear' })} />)
    fireEvent.click(screen.getByRole('button', { name: /Enable/ }))
    await settle()

    expect(requestGateway).toHaveBeenCalledWith('reload.mcp', { confirm: true, session_id: 'sess-1' })
    expect(respond).not.toHaveBeenCalled()

    finishReload()
    await settle()

    expect(respond).toHaveBeenCalledWith('req-1', { server: 'linear', status: 'enabled' })
  })

  // A reload that fails is reported, not fatal: the config landed and the tools
  // arrive next session, so the tool must still be unblocked.
  it('still unblocks the tool when the reload fails', async () => {
    park({ action: 'enable' })
    vi.mocked(requestGateway).mockRejectedValue(new Error('socket closed'))

    renderCard(<McpSetupTool {...setupProps({ server: 'linear' })} />)
    fireEvent.click(screen.getByRole('button', { name: /Enable/ }))
    await settle()

    expect(notifyError).toHaveBeenCalled()
    expect(respond).toHaveBeenCalledWith('req-1', { server: 'linear', status: 'enabled' })
  })

  // A decline changed no config, so reloading would be pure noise on a socket
  // the user is waiting on.
  it('does not reload on a decline', async () => {
    park()
    renderCard(<McpSetupTool {...setupProps({ server: 'linear' })} />)

    fireEvent.click(screen.getByRole('button', { name: /Not now/ }))
    await settle()

    expect(requestGateway).not.toHaveBeenCalled()
  })

  it('installs a URL-only remote through the shared config-merge path', async () => {
    park()
    vi.mocked(authMcpServer).mockResolvedValue({
      authorization_url: 'https://linear.app/oauth',
      error: null,
      flow_id: 'f1',
      server_name: 'linear',
      status: 'authorization_required'
    })
    vi.mocked(getMcpOAuthFlow).mockResolvedValue({
      authorization_url: null,
      error: null,
      flow_id: 'f1',
      server_name: 'linear',
      status: 'approved',
      tools: [{ description: '', name: 'create_issue' }]
    })

    renderCard(<McpSetupTool {...setupProps({ server: 'linear' })} />)
    fireEvent.click(screen.getByRole('button', { name: /Install/ }))
    await settle()

    expect(writeMcpServerEntry).toHaveBeenCalledWith('linear', { transport: 'http', url: 'https://mcp.linear.app/mcp' })
    expect(respond).toHaveBeenCalledWith('req-1', {
      server: 'linear',
      status: 'installed',
      tools: ['create_issue']
    })
  })

  // Decline means NO server — not an unauthorized entry squatting in config
  // that the next turn tries to spawn and fails on.
  it('rolls the config write back when the OAuth flow dies', async () => {
    park()
    vi.mocked(authMcpServer).mockRejectedValue(new Error('oauth refused'))

    renderCard(<McpSetupTool {...setupProps({ server: 'linear' })} />)
    fireEvent.click(screen.getByRole('button', { name: /Install/ }))
    await settle()

    expect(writeMcpServerEntry).toHaveBeenCalled()
    expect(removeMcpServerEntry).toHaveBeenCalledWith('linear')
    expect(respond).toHaveBeenCalledWith('req-1', {
      detail: 'oauth refused',
      server: 'linear',
      status: 'error'
    })
  })

  // The agent must never be left blocked by a client-side failure.
  it('answers error rather than going silent when the flow throws', async () => {
    park({ action: 'enable' })
    vi.mocked(setMcpServerEnabled).mockRejectedValue(new Error('backend down'))

    renderCard(<McpSetupTool {...setupProps({ server: 'linear' })} />)
    fireEvent.click(screen.getByRole('button', { name: /Enable/ }))
    await settle()

    expect(notifyError).toHaveBeenCalled()
    expect(respond).toHaveBeenCalledWith('req-1', { detail: 'backend down', server: 'linear', status: 'error' })
  })

  it('refuses a server that is in neither the catalog nor the directory', async () => {
    park({ server: 'not-a-real-vendor' })

    renderCard(<McpSetupTool {...setupProps({ server: 'not-a-real-vendor' })} />)
    fireEvent.click(screen.getByRole('button', { name: /Install/ }))
    await settle()

    expect(writeMcpServerEntry).not.toHaveBeenCalled()
    expect(respond).toHaveBeenCalledWith('req-1', {
      detail: '“not-a-real-vendor” is not in the MCP catalog',
      server: 'not-a-real-vendor',
      status: 'error'
    })
  })

  // Credentials are prompted for, never pre-filled and never sent before the
  // user has typed them.
  it('reveals required credentials before installing a catalog entry', async () => {
    park({ server: 'context7' })
    vi.mocked(getMcpCatalog).mockResolvedValue({
      diagnostics: [],
      entries: [
        {
          args: [],
          auth_type: 'env',
          bootstrap: [],
          command: null,
          default_enabled: null,
          description: '',
          enabled: false,
          install_ref: null,
          install_url: null,
          installed: false,
          name: 'context7',
          needs_install: false,
          post_install: '',
          required_env: [{ name: 'CONTEXT7_API_KEY', prompt: 'Context7 API key', required: true }],
          source: 'catalog',
          transport: 'http',
          url: 'https://mcp.context7.com/mcp'
        }
      ]
    })

    renderCard(<McpSetupTool {...setupProps({ server: 'context7' })} />)
    fireEvent.click(screen.getByRole('button', { name: /Install/ }))
    await settle()

    expect(installMcpCatalogEntry).not.toHaveBeenCalled()
    expect(screen.getByText('Fill in the required credentials first')).toBeTruthy()

    const field = screen.getByLabelText(/Context7 API key/)

    expect(field.getAttribute('type')).toBe('password')
    fireEvent.change(field, { target: { value: 'sk-secret' } })
    fireEvent.click(screen.getByRole('button', { name: /Install/ }))
    await settle()

    expect(installMcpCatalogEntry).toHaveBeenCalledWith('context7', { CONTEXT7_API_KEY: 'sk-secret' })
    expect(respond).toHaveBeenCalledWith('req-1', { server: 'context7', status: 'installed' })
  })

  // A background clone that exits non-zero is a FAILURE; reporting `installed`
  // would tell the agent to use tools that are not there.
  it('polls a background install to completion and fails on a non-zero exit', async () => {
    park({ server: 'linear' })
    vi.mocked(getMcpCatalog).mockResolvedValue({
      diagnostics: [],
      entries: [
        {
          args: [],
          auth_type: 'none',
          bootstrap: [],
          command: 'linear-mcp',
          default_enabled: null,
          description: '',
          enabled: false,
          install_ref: null,
          install_url: null,
          installed: false,
          name: 'linear',
          needs_install: true,
          post_install: '',
          required_env: [],
          source: 'catalog',
          transport: 'stdio',
          url: null
        }
      ]
    })
    vi.mocked(installMcpCatalogEntry).mockResolvedValue({ action: 'mcp-install', background: true, ok: true })
    vi.mocked(getActionStatus).mockResolvedValue({ exit_code: 1, running: false } as never)

    renderCard(<McpSetupTool {...setupProps({ server: 'linear' })} />)
    fireEvent.click(screen.getByRole('button', { name: /Install/ }))
    await settle()

    expect(respond).toHaveBeenCalledWith('req-1', {
      detail: 'Setup failed for Linear',
      server: 'linear',
      status: 'error'
    })
  })

  // A turn stopped mid-prompt has no result and is not running: every button
  // here would act on a request nothing can answer any more.
  it('stands down to the plain tool row when the turn is no longer running', () => {
    park()
    aui.messageRunning = false
    renderCard(<McpSetupTool {...setupProps({ server: 'linear' })} />)

    expect(screen.queryByRole('button', { name: /Not now/ })).toBeNull()
  })
})

describe('McpSetupTool — the settled row', () => {
  const settled = (result: Record<string, unknown>) =>
    renderCard(<McpSetupTool {...setupProps({ server: 'linear' }, result)} />)

  it('reports each terminal status distinctly', () => {
    settled({ server: 'linear', status: 'installed', tools: ['a', 'b'] })
    expect(screen.getByText('Installed Linear')).toBeTruthy()
    expect(screen.getByText('2 tools')).toBeTruthy()
    cleanup()

    settled({ server: 'linear', status: 'enabled' })
    expect(screen.getByText('Enabled Linear')).toBeTruthy()
    cleanup()

    settled({ server: 'linear', status: 'authorized' })
    expect(screen.getByText('Authorized Linear')).toBeTruthy()
    cleanup()

    settled({ server: 'linear', status: 'declined' })
    expect(screen.getByText('Declined')).toBeTruthy()
  })

  // `unanswered` is the TOOL's word for a 600s timeout and must NOT read as a
  // decline — the user never saw or dismissed the card.
  it('distinguishes a timeout from a decline', () => {
    settled({ server: 'linear', status: 'unanswered' })

    expect(screen.getByText('No response')).toBeTruthy()
    expect(screen.queryByText('Declined')).toBeNull()
  })

  it('surfaces the failure detail', () => {
    settled({ detail: 'oauth refused', server: 'linear', status: 'error' })

    expect(screen.getByText('Setup failed for Linear')).toBeTruthy()
    expect(screen.getByText('oauth refused')).toBeTruthy()
  })

  // No status at all is not a success — a settled row with an unreadable result
  // must not claim the server is installed.
  it('treats an unreadable result as an error', () => {
    settled({})

    expect(screen.getByText('Setup failed for Linear')).toBeTruthy()
  })
})
