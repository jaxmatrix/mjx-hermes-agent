import { useEffect, useState } from 'react'

import { useStore } from '@/store/atom'
import {
  $connectionError,
  $connectionPhase,
  connect,
  lastUrl,
  lastUsername,
  loadSavedLogin,
  probeStatus
} from '@/store/connection'

// RemoteProvider connect screen. Two steps:
//   1. Enter the backend URL → probe /api/status.
//   2. If gated (auth_required) → username + password (password-login → cookie →
//      ws-ticket). Otherwise → optional session token.
export function ConnectScreen() {
  const phase = useStore($connectionPhase)
  const connectError = useStore($connectionError)

  const [step, setStep] = useState<'url' | 'auth'>('url')
  const [gated, setGated] = useState(false)
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
      setGated(Boolean(status.auth_required))
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

        {step === 'url' && (
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

        {step === 'auth' && (
          <>
            <p className="connect-sub">
              {gated ? 'This backend requires a login.' : 'This backend is open (optional token).'}
            </p>

            {gated ? (
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
              disabled={connecting || (gated && (!username.trim() || !password))}
              onClick={onConnect}
            >
              {phase === 'probing' ? 'Checking…' : phase === 'connecting' ? 'Connecting…' : gated ? 'Sign in & connect' : 'Connect'}
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
