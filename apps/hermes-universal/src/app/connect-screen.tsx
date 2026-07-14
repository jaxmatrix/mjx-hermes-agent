import { useEffect, useState } from 'react'

import { ModePicker } from '@/app/gateway/mode-picker'
import { fetchAuthProviders } from '@/lib/auth'
import { useStore } from '@/store/atom'
import { $gatewayMode } from '@/store/gateway-switch'
import {
  $connectionError,
  $connectionPhase,
  connect,
  connectLocal,
  lastUrl,
  lastUsername,
  loadSavedLogin,
  normalizeBaseUrl,
  probeStatus
} from '@/store/connection'

// RemoteProvider connect screen. Two steps:
//   1. Enter the backend URL → probe /api/status.
//   2. If gated (auth_required) → either username + password (when a provider
//      supports it: password-login → cookie → ws-ticket) or a single-sign-on
//      button (interactive OAuth in a webview). Otherwise → optional token.
export function ConnectScreen() {
  const phase = useStore($connectionPhase)
  const connectError = useStore($connectionError)
  const mode = useStore($gatewayMode)

  const [step, setStep] = useState<'url' | 'auth'>('url')
  const [gated, setGated] = useState(false)
  const [passwordSupported, setPasswordSupported] = useState(false)
  const [checking, setChecking] = useState(false)
  const [probeError, setProbeError] = useState<string | null>(null)

  const [url, setUrl] = useState(lastUrl())
  const [token, setToken] = useState('')
  const [username, setUsername] = useState(lastUsername())
  const [password, setPassword] = useState('')

  // Secrets aren't in localStorage — prefill them from the keyring (silent).
  useEffect(() => {
    let live = true
    void loadSavedLogin().then(saved => {
      if (!live || !saved) return
      if (saved.token) setToken(saved.token)
      if (saved.password) setPassword(saved.password)
    })
    return () => {
      live = false
    }
  }, [])

  const connecting = phase === 'probing' || phase === 'connecting'

  async function onContinue() {
    setProbeError(null)
    setChecking(true)
    try {
      const status = await probeStatus(url)
      const isGated = Boolean(status.auth_required)
      setGated(isGated)
      if (isGated) {
        // Learn whether a password provider exists → username/password form, else
        // an SSO button. [] (503 / error) → treat as OAuth-only.
        const providers = await fetchAuthProviders(normalizeBaseUrl(url)).catch(() => [])
        setPasswordSupported(providers.some(p => p.supports_password))
      }
      setStep('auth')
    } catch (err) {
      setProbeError(err instanceof Error ? err.message : String(err))
    } finally {
      setChecking(false)
    }
  }

  function onConnect() {
    void connect({ url, token, username, password })
  }

  return (
    <main className="connect">
      <div className="connect-card">
        <div className="brand">Hermes</div>
        <h1 className="connect-title">Connect to Hermes</h1>

        <div className="mb-4">
          <ModePicker />
        </div>

        {mode === 'local' && (
          <>
            <p className="connect-sub">Start a bundled Hermes backend on this device.</p>
            {connectError && <div className="error-line">{connectError}</div>}
            <button className="btn btn-primary" disabled={connecting} onClick={() => void connectLocal()}>
              {phase === 'connecting' ? 'Starting…' : 'Start local backend'}
            </button>
          </>
        )}

        {mode === 'cloud' && (
          <p className="connect-sub">
            Cloud — sign in to the Nous portal and pick an agent. {/* E5 wires the agent list */}
          </p>
        )}

        {mode === 'remote' && step === 'url' && (
          <>
            <p className="connect-sub">Point the app at a Hermes backend on your network.</p>
            <label className="field-label" htmlFor="url">
              Backend URL
            </label>
            <input
              id="url"
              className="field"
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="192.168.1.20:8788"
              value={url}
              onChange={e => setUrl(e.target.value)}
            />
            {probeError && <div className="error-line">{probeError}</div>}
            <button className="btn btn-primary" disabled={checking || !url.trim()} onClick={() => void onContinue()}>
              {checking ? 'Checking…' : 'Continue'}
            </button>
          </>
        )}

        {mode === 'remote' && step === 'auth' && (
          <>
            <p className="connect-sub">
              {gated
                ? passwordSupported
                  ? 'This backend requires a login.'
                  : 'This backend uses single sign-on. You’ll be taken to your provider to sign in.'
                : 'This backend is open (optional token).'}
            </p>

            {gated ? (
              passwordSupported ? (
                <>
                  <label className="field-label" htmlFor="username">
                    Username
                  </label>
                  <input
                    id="username"
                    className="field"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    placeholder="admin"
                    value={username}
                    onChange={e => setUsername(e.target.value)}
                  />
                  <label className="field-label" htmlFor="password">
                    Password
                  </label>
                  <input
                    id="password"
                    className="field"
                    type="password"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    placeholder="password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                  />
                </>
              ) : null
            ) : (
              <>
                <label className="field-label" htmlFor="token">
                  Session token <span className="muted">(if required)</span>
                </label>
                <input
                  id="token"
                  className="field"
                  type="password"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder="paste token"
                  value={token}
                  onChange={e => setToken(e.target.value)}
                />
              </>
            )}

            {connectError && <div className="error-line">{connectError}</div>}

            <button
              className="btn btn-primary"
              disabled={connecting || (gated && passwordSupported && (!username.trim() || !password))}
              onClick={onConnect}
            >
              {phase === 'probing'
                ? 'Checking…'
                : phase === 'connecting'
                  ? 'Connecting…'
                  : gated
                    ? passwordSupported
                      ? 'Sign in & connect'
                      : 'Sign in with SSO'
                    : 'Connect'}
            </button>
            <button className="btn btn-text" disabled={connecting} onClick={() => setStep('url')}>
              Change URL
            </button>
          </>
        )}
      </div>
    </main>
  )
}
