import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as Hermes from '@/hermes'
import type * as McpServers from '@/lib/mcp-servers'

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
    getMcpCatalog: vi.fn().mockResolvedValue({ diagnostics: [], entries: [] }),
    getMcpOAuthFlow: vi.fn(),
    listMcpServers: vi.fn().mockResolvedValue({ servers: [] })
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
vi.mock('@/store/notifications', () => ({ notify: vi.fn(), notifyError: vi.fn() }))

import { authMcpServer, getMcpCatalog, getMcpOAuthFlow, listMcpServers } from '@/hermes'
import { removeMcpServerEntry, writeMcpServerEntry } from '@/lib/mcp-servers'
import { $composerSuggestionsBySession, sampleComposerDraft } from '@/store/composer-suggestions'
import { requestGateway } from '@/store/gateway'
import { notifyError } from '@/store/notifications'
import { invalidateMcpSuggestionIndex, matchSuggestions } from '@/store/suggestion-providers/mcp'

const INDEX = [
  { hosts: ['atlassian.net', 'jira.com'], keywords: ['jira', 'confluence'], server: 'atlassian' },
  { hosts: ['linear.app'], keywords: ['linear'], server: 'linear' },
  { hosts: ['figma.com'], keywords: ['figma', 'design file'], server: 'figma' },
  { keywords: ['squareup'], server: 'square' }
]

describe('matchSuggestions — keyword triggers', () => {
  // The completed-word guard (upstream fb1ee93a63): a hit still under the caret
  // is a word in progress, not intent. Seeded to disagree — the naive
  // whole-word matcher passes the first case and fails only on the second.
  it('waits for the word to be finished', () => {
    expect(matchSuggestions('can you check linear', INDEX)).toEqual([])
    expect(matchSuggestions('can you check linear ', INDEX)).toEqual([{ keyword: 'linear', server: 'linear' }])
    expect(matchSuggestions('can you check linear?', INDEX)).toEqual([{ keyword: 'linear', server: 'linear' }])
  })

  it('matches whole words only, so a longer word is not a hit', () => {
    expect(matchSuggestions('scaling linearly here', INDEX)).toEqual([])
    expect(matchSuggestions('the jirasaurus rex is fine', INDEX)).toEqual([])
  })

  it('is case-insensitive and matches multi-word phrases', () => {
    expect(matchSuggestions('open the JIRA board now', INDEX)).toEqual([{ keyword: 'jira', server: 'atlassian' }])
    expect(matchSuggestions('grab the design file first', INDEX)).toEqual([{ keyword: 'design file', server: 'figma' }])
  })

  // Not a substring hunt: the English word "square" is everywhere, so only the
  // brand spelling triggers it.
  it('does not fire on a keyword that is a plain English word', () => {
    expect(matchSuggestions('draw a square on the canvas ', INDEX)).toEqual([])
    expect(matchSuggestions('pay via squareup please ', INDEX)).toEqual([{ keyword: 'squareup', server: 'square' }])
  })

  it('caps at two suggestions however many match', () => {
    expect(matchSuggestions('jira and linear and figma all of them ', INDEX)).toHaveLength(2)
  })

  it('offers a server at most once', () => {
    expect(matchSuggestions('jira jira confluence confluence ', INDEX)).toEqual([
      { keyword: 'jira', server: 'atlassian' }
    ])
  })
})

describe('matchSuggestions — pasted-link triggers', () => {
  // A pasted link routinely ENDS the draft, so host hits are exempt from the
  // completed-word guard. Seeded to disagree: no trailing character.
  it('fires on a pasted vendor URL with nothing after it', () => {
    expect(matchSuggestions('look at https://myorg.atlassian.net/browse/ABC-1', INDEX)).toEqual([
      { keyword: 'atlassian.net', server: 'atlassian' }
    ])
  })

  // Suffix on a DOT boundary, or a lookalike domain gets you a vendor pill.
  // The fixture carries no vendor WORD, so only the host matcher can decide it.
  it('will not match a lookalike host', () => {
    expect(matchSuggestions('https://sublinear.appx/y ', INDEX)).toEqual([])
    expect(matchSuggestions('https://acme.linear.app/x ', INDEX)).toEqual([{ keyword: 'linear.app', server: 'linear' }])
  })

  // `linear.app.example.com` is somebody else's domain. The suffix check
  // rejects it as a HOST — which is visible in the trigger reported: the pill
  // says it fired on the word "linear", not on the vendor endpoint. Asserting
  // the reported trigger is the only thing that separates the two paths here.
  it('reports the keyword, not the host, when the host only looks like the vendor', () => {
    expect(matchSuggestions('https://linear.app.example.com/x ', INDEX)).toEqual([
      { keyword: 'linear', server: 'linear' }
    ])
  })

  it('ignores credentials and ports in the URL', () => {
    expect(matchSuggestions('https://user@linear.app:443/issue ', INDEX)).toEqual([
      { keyword: 'linear.app', server: 'linear' }
    ])
  })

  it('tolerates trailing punctuation after the host', () => {
    expect(matchSuggestions('see https://linear.app, then reply ', INDEX)).toEqual([
      { keyword: 'linear.app', server: 'linear' }
    ])
  })

  // A URL is a deliberate act; a keyword is a mention. When both hit the SAME
  // server the tooltip must name the stronger signal.
  it('reports the host as the trigger when both would match', () => {
    expect(matchSuggestions('linear https://linear.app/x ', INDEX)).toEqual([
      { keyword: 'linear.app', server: 'linear' }
    ])
  })

  // Host matching runs against URLs, not against prose. `atlassian` is not one
  // of that entry's keywords in this fixture, so nothing else could match here
  // and a hit would mean the matcher had started scanning bare text for hosts.
  it('ignores a bare hostname that is not in a URL', () => {
    expect(matchSuggestions('my domain is atlassian.net and it is fine ', INDEX)).toEqual([])
    expect(matchSuggestions('my domain is https://atlassian.net ', INDEX)).toEqual([
      { keyword: 'atlassian.net', server: 'atlassian' }
    ])
  })
})

describe('the MCP draft provider', () => {
  const suggestionsFor = (key: string) => $composerSuggestionsBySession.get()[key] ?? []

  // Each test samples under its OWN session key. The bus's declined ledger
  // quiets a suggestion after three uninvoked withdrawals, and that ledger is
  // session-scoped and module-lived — reusing one key would make every test
  // after the third silently assert against a quieted pill.
  let seq = 0
  const nextKey = () => `s-${(seq += 1)}`

  const sample = async (text: string, key: string) => {
    vi.useFakeTimers()
    sampleComposerDraft(key, text)
    await vi.advanceTimersByTimeAsync(700)
    vi.useRealTimers()
    // The provider awaits two fetches after the debounce fires.
    await new Promise(resolve => setTimeout(resolve, 0))
    await new Promise(resolve => setTimeout(resolve, 0))
  }

  const catalogWith = (suggest: null | { hosts: string[]; keywords: string[] }, name = 'linear') =>
    vi.mocked(getMcpCatalog).mockResolvedValue({
      diagnostics: [],
      entries: [
        {
          args: [],
          auth_type: 'oauth',
          bootstrap: [],
          command: null,
          default_enabled: null,
          description: '',
          enabled: false,
          install_ref: null,
          install_url: null,
          installed: false,
          name,
          needs_install: false,
          post_install: '',
          required_env: [],
          source: 'catalog',
          suggest,
          transport: 'http',
          url: 'https://catalog.example/mcp'
        }
      ]
    })

  let key = ''

  beforeEach(() => {
    vi.clearAllMocks()
    invalidateMcpSuggestionIndex()
    $composerSuggestionsBySession.set({})
    key = nextKey()
    vi.mocked(listMcpServers).mockResolvedValue({ servers: [] })
    vi.mocked(getMcpCatalog).mockResolvedValue({ diagnostics: [], entries: [] })
    vi.mocked(writeMcpServerEntry).mockResolvedValue({})
  })

  it('offers a pill from the catalog suggest block', async () => {
    catalogWith({ hosts: [], keywords: ['linear'] })
    await sample('check linear now ', key)

    expect(suggestionsFor(key).map(s => s.label)).toEqual(['Add Linear'])
    expect(suggestionsFor(key)[0]?.tip).toBe('Suggested because you mentioned “linear” — click to connect')
  })

  // The catalog is the source of truth; the static directory is the fallback
  // rung for backends that predate `suggest`. Seeded to disagree: the catalog
  // answers, it just carries no suggest metadata.
  it('falls back to the static directory when no entry declares suggest', async () => {
    catalogWith(null)
    await sample('check linear now ', key)

    expect(suggestionsFor(key).map(s => s.id)).toEqual(['linear'])
  })

  // A server already in config needs a toggle at most, not "add this server".
  it('does not offer a server that is already configured', async () => {
    catalogWith(null)
    vi.mocked(listMcpServers).mockResolvedValue({ servers: [{ name: 'linear' } as never] })
    await sample('check linear now ', key)

    expect(suggestionsFor(key)).toEqual([])
  })

  it('does not touch the network for a draft with no hit at all', async () => {
    catalogWith(null)
    await sample('just some ordinary words here ', key)

    expect(listMcpServers).not.toHaveBeenCalled()
    expect(suggestionsFor(key)).toEqual([])
  })

  // Suggesting the wrong thing is worse than suggesting nothing.
  it('offers nothing when the catalog is unreachable', async () => {
    vi.mocked(getMcpCatalog).mockRejectedValue(new Error('offline'))
    await sample('check linear now ', key)

    expect(suggestionsFor(key)).toEqual([])
  })

  it('connects through the shared config-merge path and reloads the live session', async () => {
    catalogWith(null)
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
      status: 'approved'
    })

    await sample('check linear now ', key)
    await suggestionsFor(key)[0]!.invoke({ cancelled: () => false, sessionId: key })

    expect(writeMcpServerEntry).toHaveBeenCalledWith('linear', { transport: 'http', url: 'https://mcp.linear.app/mcp' })
    expect(requestGateway).toHaveBeenCalledWith('reload.mcp', { confirm: true, session_id: key })
  })

  // Decline means NO server, not an unauthorized entry squatting in config.
  it('rolls the config write back when the OAuth flow fails', async () => {
    catalogWith(null)
    vi.mocked(authMcpServer).mockRejectedValue(new Error('oauth refused'))

    await sample('check linear now ', key)
    await expect(suggestionsFor(key)[0]!.invoke({ cancelled: () => false, sessionId: key })).rejects.toThrow(
      'oauth refused'
    )

    expect(removeMcpServerEntry).toHaveBeenCalledWith('linear')
    expect(requestGateway).not.toHaveBeenCalled()
    expect(notifyError).toHaveBeenCalled()
  })

  // A user cancel is not an error; toasting it would be the app complaining
  // about a thing the user just chose to do.
  it('rolls back but stays quiet when the user cancels the OAuth', async () => {
    catalogWith(null)
    vi.mocked(authMcpServer).mockResolvedValue({
      authorization_url: 'https://linear.app/oauth',
      error: null,
      flow_id: 'f1',
      server_name: 'linear',
      status: 'authorization_required'
    })

    await sample('check linear now ', key)
    await expect(suggestionsFor(key)[0]!.invoke({ cancelled: () => true, sessionId: key })).rejects.toThrow()

    expect(removeMcpServerEntry).toHaveBeenCalledWith('linear')
    expect(notifyError).not.toHaveBeenCalled()
  })

  // The reload must reach the chat the user is LOOKING at, not the one the
  // sample was taken in — one composer survives a session switch.
  it('reloads the pill own session, not the sampled one', async () => {
    catalogWith(null)
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
      status: 'approved'
    })

    await sample('check linear now ', key)
    await suggestionsFor(key)[0]!.invoke({ cancelled: () => false, sessionId: 's-other' })

    expect(requestGateway).toHaveBeenCalledWith('reload.mcp', { confirm: true, session_id: 's-other' })
  })
})
