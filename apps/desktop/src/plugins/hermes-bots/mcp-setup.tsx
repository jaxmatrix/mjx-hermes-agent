/**
 * Inline per-profile MCP setup: the `mcp.servers.*` RPC wrapper, its
 * feature-detect, and the button a capability row renders.
 *
 * Shared leaf: the advanced profile editor and the create dialog both render
 * the button, so it lives below both.
 */

import { Button, host, Input, useI18n } from '@hermes/plugin-sdk'
import { useEffect, useRef, useState } from 'react'

import { requestForBot } from './routing'
import type { RosterRow } from './types'

// -- inline MCP setup (per-profile), driven by the mcp.servers.* gateway RPCs --
// Feature-detected: if the gateway predates those RPCs the setup button hides
// and the row falls back to the "run hermes mcp / Settings" hint. profile is
// the target bot's profile name (its config is what we write).

/** Body of an `mcp.servers.*` reply. Some gateway builds wrap it in a second
 *  `result` envelope, which every call site below unwraps — hence the
 *  self-reference. */
interface McpServerPayload {
  auth_url?: string
  error?: string
  error_message?: string
  ok?: boolean
  result?: McpServerPayload
  session_id?: string
  status?: string
  verification_url?: string
}

/** `mcpRpc`'s outcome. `unsupported` separates an older gateway that doesn't
 *  know the method from a real failure. */
interface McpRpcResult {
  error?: string
  ok: boolean
  result?: McpServerPayload
  unsupported?: boolean
}

/** The capability scope the Edit Profile / New Bot panes hand down — the SDK's
 *  `ProfileScope`: a bare profile name, or a connection-qualified scope for a
 *  source-scoped bot. */
type McpSetupScope = null | string | undefined | { connectionId?: null | string; profile?: null | string }

/** Gateway always wants a profile NAME string; connectionId routes the RPC. */
interface McpHome {
  connectionId?: string
  profile: string
}

function normalizeMcpHome(scope: McpSetupScope): McpHome | null {
  if (scope == null) {
    return null
  }

  if (typeof scope === 'string') {
    const profile = scope.trim()

    return profile ? { profile } : null
  }

  const profile = String(scope.profile || '').trim()

  if (!profile) {
    return null
  }

  const connectionId = String(scope.connectionId || '').trim() || undefined

  return connectionId ? { connectionId, profile } : { profile }
}

function botStubForHome(home: McpHome): Partial<RosterRow> {
  if (!home.connectionId) {
    return { name: home.profile }
  }

  return {
    connectionId: home.connectionId,
    name: home.profile,
    remoteSource: true,
    sourceScoped: true
  }
}

async function mcpRpc(
  method: string,
  params: Record<string, unknown>,
  home?: McpHome | null
): Promise<McpRpcResult> {
  // Gateway `profile` is always a NAME string. When home carries a connectionId,
  // route via requestForBot so Edit Profile on a remote bot hits that gateway.
  const body =
    home?.profile != null
      ? {
          ...params,
          profile: home.profile
        }
      : params

  try {
    const res = home?.connectionId
      ? await requestForBot<McpServerPayload>(botStubForHome(home), method, body)
      : await host.request<McpServerPayload>(method, body)

    return {
      ok: true,
      result: res
    }
  } catch (err: any) {
    const msg = String((err && err.message) || err || '')

    if (/unknown method/i.test(msg)) {
      return {
        ok: false,
        unsupported: true
      }
    }

    return {
      ok: false,
      error: msg
    }
  }
}

// Probe whether the new lifecycle RPCs exist on this gateway (cached per session).
let _mcpRpcSupported: boolean | null = null

async function mcpSetupSupported(): Promise<boolean> {
  if (_mcpRpcSupported !== null) {
    return _mcpRpcSupported
  }

  const r = await mcpRpc('mcp.servers.list', {})
  _mcpRpcSupported = !(r.ok === false && r.unsupported)

  return _mcpRpcSupported
}

/** One row of the capability pane's MCP list (catalog entry or installed server). */
interface McpCatalogEntry {
  auth?: null | string
  fromCatalog?: boolean
  installed?: boolean
  name: string
  requires?: string[]
}

interface McpSetupButtonProps {
  ensureProfile?: () => Promise<null | string>
  entry: McpCatalogEntry
  onDone?: () => void
  profile: McpSetupScope
}

export function McpSetupButton({ profile, entry, onDone, ensureProfile }: McpSetupButtonProps) {
  const { t } = useI18n()
  // entry: { name, requires:[env keys], auth?, fromCatalog, installed }
  // profile may be null at first (New Bot: the profile isn't created yet).
  // ensureProfile() lazily creates it on the first setup action and returns the
  // slug, so OAuth / API-key setup works DURING creation, not only in Edit.
  const [phase, setPhase] = useState<'busy' | 'done' | 'error' | 'idle' | 'keys' | 'oauth'>('idle') // idle | keys | oauth | busy | done | error
  const [supported, setSupported] = useState<boolean | null>(null)
  const [keyValues, setKeyValues] = useState<Record<string, string>>({})
  const [message, setMessage] = useState('')
  const oauthEpoch = useRef(0)
  // Holds ONLY the profile this component created on demand. The live prop
  // wins wherever both exist, so there is nothing to mirror into the ref and
  // no render of lag between the parent supplying a profile and us using it.
  const createdProfileRef = useRef<McpSetupScope>(null)

  // Resolve the target home, creating a profile slug on demand for New Bot.
  const resolveHome = async (): Promise<McpHome | null> => {
    const known = normalizeMcpHome(profile || createdProfileRef.current)

    if (known) {
      return known
    }

    if (ensureProfile) {
      const created = await ensureProfile()

      if (created) {
        createdProfileRef.current = created
      }

      return normalizeMcpHome(created)
    }

    return null
  }

  useEffect(() => {
    const epoch = oauthEpoch
    let alive = true
    mcpSetupSupported().then(ok => {
      if (alive) {
        setSupported(ok)
      }
    })

    return () => {
      alive = false

      epoch.current++
    }
  }, [])
  const isOAuth = (entry.auth || '').toLowerCase() === 'oauth'
  const requires = entry.requires || []

  const beginKeys = async () => {
    // Ensure the server exists in the target profile first (add from catalog).
    setPhase('busy')
    setMessage('')
    const home = await resolveHome()

    if (!home) {
      setPhase('idle')

      return
    }

    if (entry.fromCatalog && !entry.installed) {
      const add = await mcpRpc(
        'mcp.servers.add',
        {
          name: entry.name,
          preset: entry.name
        },
        home
      )

      if (!add.ok) {
        setPhase('error')
        setMessage(add.error || 'Could not add server')

        return
      }
    }

    setPhase(isOAuth ? 'oauth' : 'keys')
  }

  const submitKeys = async () => {
    setPhase('busy')
    const home = normalizeMcpHome(profile || createdProfileRef.current)

    if (!home) {
      setPhase('error')
      setMessage('No target profile')

      return
    }

    for (const k of requires) {
      const val = (keyValues[k] || '').trim()

      if (!val) {
        continue
      }

      const r = await mcpRpc(
        'mcp.servers.set_api_key',
        {
          name: entry.name,
          env_var: k,
          value: val
        },
        home
      )

      if (!r.ok) {
        setPhase('error')
        setMessage(r.error || 'Failed to set ' + k)

        return
      }
    }

    // Verify via test.
    const t = await mcpRpc(
      'mcp.servers.test',
      {
        name: entry.name
      },
      home
    )

    if (t.ok && t.result && (t.result.ok || (t.result.result && t.result.result.ok))) {
      setPhase('done')
      host.notify({
        kind: 'success',
        message: entry.name + ' configured'
      })
      onDone && onDone()
    } else {
      setPhase('error')
      setMessage(
        (t.result && (t.result.error || (t.result.result && t.result.result.error))) || 'Server test failed after setup'
      )
    }
  }

  const beginOAuth = async () => {
    const epoch = ++oauthEpoch.current

    setPhase('busy')
    setMessage('')
    const home = await resolveHome()

    if (!home) {
      setPhase('idle')

      return
    }

    const oauthScope = {
      connectionId: home.connectionId ?? host.state.connectionId.get(),
      profile: home.profile
    }

    try {
      setPhase('oauth')
      setMessage('Complete sign-in in your browser...')
      await host.completeMcpOAuth({
        serverName: entry.name,
        profile: oauthScope,
        catalogPreset: entry.fromCatalog && !entry.installed ? entry.name : undefined,
        cancelled: () => oauthEpoch.current !== epoch
      })

      if (oauthEpoch.current !== epoch) {
        return
      }

      setPhase('done')
      host.notify({ kind: 'success', message: entry.name + ' authenticated' })
      onDone?.()
    } catch (error) {
      if (oauthEpoch.current !== epoch) {
        return
      }

      setPhase('error')
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }

  if (supported === false) {
    return (
      <span className="ms-1.5 text-[0.65rem] text-(--ui-text-quaternary)">
        {'needs setup (' + requires.join(', ') + ') \u2014 restart the gateway to enable in-app setup'}
      </span>
    )
  }

  if (phase === 'done') {
    return <span className="ms-1.5 text-[0.65rem] text-(--ui-success)">set up ✓</span>
  }

  if (phase === 'keys') {
    return (
      <div className="mt-1 grid gap-1">
        {requires.map(k => (
          <Input
            className="h-6 text-[0.7rem]"
            key={k}
            onChange={e =>
              setKeyValues(prev => ({
                ...prev,
                [k]: e.target.value
              }))
            }
            placeholder={k}
            type="password"
            value={keyValues[k] || ''}
          />
        ))}
        <div className="flex gap-1">
          <Button onClick={() => void submitKeys()} size="xs" variant="secondary">
            Save & test
          </Button>
          <Button onClick={() => setPhase('idle')} size="xs" variant="ghost">
            {t.common.cancel}
          </Button>
        </div>
      </div>
    )
  }

  if (phase === 'oauth') {
    return <span className="ms-1.5 text-[0.65rem] text-(--ui-text-quaternary)">{message || 'Authorizing\u2026'}</span>
  }

  if (phase === 'busy') {
    return <span className="ms-1.5 text-[0.65rem] text-(--ui-text-quaternary)">Working…</span>
  }

  if (phase === 'error') {
    return (
      <span className="ms-1.5 text-[0.65rem] text-(--ui-danger,#f87171)">
        {(message || 'Setup failed') + ' '}
        <Button className="underline" onClick={() => setPhase('idle')} size="inline" variant="link">
          retry
        </Button>
      </span>
    )
  }

  // idle
  return (
    <Button
      className="ms-1.5 text-[0.65rem] text-(--ui-accent) underline"
      onClick={() => void (isOAuth ? beginOAuth() : beginKeys())}
      size="inline"
      variant="link"
    >
      {isOAuth ? 'Sign in\u2026' : 'Set up\u2026'}
    </Button>
  )
}

/** Test seam: normalize scope the button uses for gateway RPCs. */
export function mcpHomeForTest(scope: McpSetupScope): McpHome | null {
  return normalizeMcpHome(scope)
}

/** Test seam: exercise home-routed mcp.servers.* without mounting the button. */
export function mcpRpcForTest(
  method: string,
  params: Record<string, unknown>,
  scope: McpSetupScope
): Promise<McpRpcResult> {
  return mcpRpc(method, params, normalizeMcpHome(scope))
}
