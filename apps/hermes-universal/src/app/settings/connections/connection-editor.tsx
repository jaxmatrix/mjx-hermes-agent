import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Input } from '@/components/ui/input'
import { useI18n } from '@/i18n'
import { connectionEndpointLabel } from '@/lib/connection-display'
import {
  type ConnectionSaveInput,
  type ConnectionView,
  type ProbeResult,
  type RegistryView,
  removeConnection,
  saveConnection,
  selectConnection,
  setPrimaryConnection,
  testConnection
} from '@/store/connections'
import type { GatewayMode } from '@/store/gateway-config'
import { notify, notifyError } from '@/store/notifications'

/**
 * ONE SOURCE'S STORED FIELDS.
 *
 * Deliberately NOT `GatewayConfigurator`. That component is the CONNECT surface
 * — mode cards, live progress, host-key trust, the SSH install offer, "Save &
 * reconnect" — and every one of those is a connect-time concern that a stored
 * descriptor does not have. This form's persistence is `connections_save`, whose
 * credential fields are write-only and land in the keyring; the configurator's
 * is "dial it now". Fusing them would put registry semantics through 1200 lines
 * that own the app's front door, for fields this form states in forty.
 *
 * The connect path is unchanged: pressing Connect runs `selectConnection`, which
 * routes through the SAME `connect*` helpers the configurator drives, so the SSH
 * prompts, host-key trust and progress steps all still happen where they always
 * did.
 *
 * NOTHING HERE EVER HOLDS A SECRET. A stored token is `hasToken` plus four
 * characters; typing a new one sends it once, write-only, and it is never echoed
 * back.
 */

export interface ConnectionDraft {
  id?: string
  kind: GatewayMode
}

const KIND_ORDER: GatewayMode[] = ['remote', 'ssh', 'cloud', 'local']

export function ConnectionEditor({
  connection,
  draft,
  registry,
  onSaved
}: {
  connection?: ConnectionView
  draft?: ConnectionDraft
  registry: RegistryView
  onSaved: (connectionId: string) => void
}) {
  const { t } = useI18n()
  const c = t.settings.connections
  const kind = connection?.kind ?? draft?.kind ?? 'remote'

  const [label, setLabel] = useState(connection?.label ?? '')
  const [url, setUrl] = useState(connection?.url ?? '')
  const [host, setHost] = useState(connection?.host ?? '')
  const [remoteProfile, setRemoteProfile] = useState(connection?.remoteProfile ?? '')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [probe, setProbe] = useState<null | ProbeResult>(null)

  // No re-seeding effect: the page keys this component on the selected id, so
  // moving the selection REMOUNTS it and every field starts from the new row.
  // An effect would be a second source of truth for the same thing, and the one
  // that runs a frame late.

  const isRemoteLike = kind === 'remote' || kind === 'cloud'
  const readOnly = registry.readOnly || kind === 'local'

  const save = async () => {
    setBusy(true)

    try {
      const input: ConnectionSaveInput = {
        id: connection?.id,
        kind,
        label: label.trim(),
        ...(isRemoteLike ? { url: url.trim() } : {}),
        ...(kind === 'ssh' ? { host: host.trim(), remoteProfile: remoteProfile.trim() || undefined } : {}),
        // `undefined` leaves a stored token alone; an EMPTY string deletes it.
        ...(token ? { authMode: 'token' as const, token } : {})
      }

      const outcome = await saveConnection(input)

      setToken('')

      if (outcome.droppedHeaders.length > 0) {
        // Reported, never silent: a header the transport refuses would otherwise
        // fail this gateway later with nothing to point at.
        notify({ kind: 'warning', message: c.droppedHeaders(outcome.droppedHeaders.join(', ')), title: c.saved })
      }

      onSaved(outcome.connectionId)
    } catch (error) {
      notifyError(error, c.saveFailed)
    } finally {
      setBusy(false)
    }
  }

  const runTest = async () => {
    if (!connection) {
      return
    }

    setBusy(true)

    try {
      setProbe(await testConnection(connection.id))
    } catch (error) {
      notifyError(error, c.testFailed)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-4 p-4">
      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium" htmlFor="connection-label">{c.fieldLabel}</label>
        <Input
          disabled={readOnly}
          id="connection-label"
          onChange={event => setLabel(event.target.value)}
          placeholder={c.fieldLabelPlaceholder}
          value={label}
        />
      </div>

      {isRemoteLike && (
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium" htmlFor="connection-url">{c.fieldUrl}</label>
          <Input
            disabled={readOnly}
            id="connection-url"
            onChange={event => setUrl(event.target.value)}
            placeholder="https://gateway.example.com"
            value={url}
          />
        </div>
      )}

      {kind === 'ssh' && (
        <>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium" htmlFor="connection-host">{c.fieldHost}</label>
            <Input
              disabled={readOnly}
              id="connection-host"
              onChange={event => setHost(event.target.value)}
              placeholder="user@host:22"
              value={host}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium" htmlFor="connection-remote-profile">{c.fieldRemoteProfile}</label>
            <Input
              disabled={readOnly}
              id="connection-remote-profile"
              onChange={event => setRemoteProfile(event.target.value)}
              placeholder="default"
              value={remoteProfile}
            />
          </div>
        </>
      )}

      {isRemoteLike && (
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium" htmlFor="connection-token">{c.fieldToken}</label>
          <Input
            autoComplete="off"
            disabled={readOnly || !registry.keyringAvailable}
            id="connection-token"
            onChange={event => setToken(event.target.value)}
            placeholder={connection?.hasToken ? `••••${connection.tokenPreview ?? ''}` : c.fieldTokenPlaceholder}
            type="password"
            value={token}
          />
          {!registry.keyringAvailable && (
            // No plaintext fallback is offered, ever — universal has no plaintext
            // credential store and must not grow one.
            <p className="text-xs text-muted-foreground">{c.noKeyring}</p>
          )}
        </div>
      )}

      {connection && connectionEndpointLabel(connection) && (
        <p className="text-xs text-muted-foreground">{connectionEndpointLabel(connection)}</p>
      )}

      {probe && (
        <div className="rounded-md border border-border p-3 text-sm">
          <p className="font-medium">{c.verdict(probe.verdict)}</p>
          <p className="text-xs text-muted-foreground">
            {c.legHttp(probe.http.ok, probe.http.status ?? 0, probe.http.ms)} · {c.legWs(probe.ws.ok, probe.ws.ms)}
          </p>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button disabled={busy || readOnly || !label.trim()} onClick={() => void save()} size="sm">
          {c.save}
        </Button>

        {connection && (
          <>
            <Button disabled={busy} onClick={() => void runTest()} size="sm" variant="secondary">
              <Codicon name="pulse" size="0.9rem" />
              {c.test}
            </Button>
            <Button disabled={busy} onClick={() => void selectConnection(connection.id)} size="sm" variant="secondary">
              {c.connect}
            </Button>
            {registry.primary !== connection.id && (
              <Button
                disabled={busy || registry.readOnly}
                onClick={() => void setPrimaryConnection(connection.id)}
                size="sm"
                variant="ghost"
              >
                {c.setPrimary}
              </Button>
            )}
            {connection.kind !== 'local' && (
              <Button
                disabled={busy || registry.readOnly}
                onClick={() => void removeConnection(connection.id).catch(error => notifyError(error, c.removeFailed))}
                size="sm"
                variant="ghost"
              >
                {c.remove}
              </Button>
            )}
          </>
        )}
      </div>

      {!connection && (
        <p className="text-xs text-muted-foreground">
          {KIND_ORDER.filter(entry => entry !== 'local' || registry.localSupported).includes(kind)
            ? c.kindHint(kind)
            : c.localUnsupported}
        </p>
      )}
    </div>
  )
}
