import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { $restDoorEnabled } from '@/contrib/plugin-disk'
import { discoverRuntimePlugins } from '@/contrib/runtime-loader'
import { useI18n } from '@/i18n'
import { ExternalLink } from '@/lib/external-link'
import { AlertTriangle } from '@/lib/icons'
import { resolvePluginSourceLinks } from '@/lib/plugin-source-urls'
import { loadAgentPlugins } from '@/store/agent-plugins'
import { $connection } from '@/store/connection'
import { $connectionReady } from '@/store/connection-ready'
import { requestGateway } from '@/store/gateway'
import { modeIsRemoteLike } from '@/store/gateway-config'
import { notify } from '@/store/notifications'
import {
  $pluginInstallRequest,
  closePluginInstallRequest,
  installPluginRequest,
  type PluginInstallFailure
} from '@/store/plugin-install-request'
import { openAppRoute } from '@/store/windows'

import { NEW_CHAT_ROUTE, PLUGINS_SETTINGS_ROUTE, SETTINGS_ROUTE } from '../routes'

import { Pill } from './primitives'

/**
 * The consent gate for installing a plugin from git.
 *
 * TWO front doors, one decision (the MJXHRM-456 pattern): Settings ▸ Plugins ▸
 * "Install from Git…" and a `hermes://plugin/install` deep link both park a
 * request on `$pluginInstallRequest`, and this is the only thing that can act on
 * it. It NEVER auto-installs — a deep link is a web page's request, not the
 * user's.
 *
 * The two origins are weighted differently on purpose. A link says so in a
 * leading line and does NOT get its Install button focused: a dialog that opens
 * with a focused install button is one Enter away from installing something the
 * user never chose. A click from Settings focuses it, because the user just
 * asked.
 *
 * Rule 26 is why the authority sentence is a sentence and not a tooltip: plugin
 * isolation is ERROR isolation. Nothing in this dialog may imply a sandbox.
 */
export function PluginInstallModal() {
  const { t } = useI18n()
  const p = t.pluginInstall
  const request = useStore($pluginInstallRequest)
  const ready = useStore($connectionReady)
  const connection = useStore($connection)
  const restDoorEnabled = useStore($restDoorEnabled)

  const [repo, setRepo] = useState('')
  const [force, setForce] = useState(false)
  const [enable, setEnable] = useState(true)
  const [installing, setInstalling] = useState(false)
  const [failure, setFailure] = useState<null | { kind: PluginInstallFailure; message: string }>(null)

  useEffect(() => {
    if (!request) {
      return
    }

    setRepo(request.repo)
    setForce(request.force ?? false)
    setEnable(request.enable ?? true)
    setInstalling(false)
    setFailure(null)

    // Anti-burial: Settings is a full-screen overlay painted ABOVE this dialog,
    // so a link that arrives while it is open would park a question nothing
    // shows. Only for a link — a user who clicked "Install from Git…" inside
    // Settings should stay where they are.
    if (request.origin === 'deep-link' && window.location.hash.startsWith(`#${SETTINGS_ROUTE}`)) {
      openAppRoute(NEW_CHAT_ROUTE)
    }
  }, [request])

  if (!request) {
    return null
  }

  // Editable only from Settings, where the user is typing an identifier. A deep
  // link's repository is the thing being consented to, so it is shown as it
  // arrived and cannot be quietly different from what the dialog says.
  const editable = request.origin === 'settings'
  const links = resolvePluginSourceLinks(repo)
  // A remote gateway plus the gateway door switched off means the python half
  // installs and the desktop half never loads. Said BEFORE installing, because a
  // silent half-install is exactly the failure this rule exists to prevent.
  const halfInstall = !restDoorEnabled && modeIsRemoteLike(connection?.mode)
  const canInstall = Boolean(links) && ready && !installing

  const close = () => {
    if (!installing) {
      closePluginInstallRequest()
    }
  }

  const run = async () => {
    if (!canInstall) {
      return
    }

    setInstalling(true)
    setFailure(null)

    const outcome = await installPluginRequest({ ...request, enable, force, repo })

    setInstalling(false)

    if (!outcome.ok) {
      setFailure({ kind: outcome.failure, message: outcome.message })

      return
    }

    const name = typeof outcome.result.name === 'string' ? outcome.result.name : repo
    const warnings = Array.isArray(outcome.result.warnings) ? outcome.result.warnings : []
    const missingEnv = Array.isArray(outcome.result.missing_env) ? outcome.result.missing_env : []

    notify({ kind: 'success', message: p.agentSuccess(name), title: p.title })

    for (const warning of warnings) {
      notify({ kind: 'warning', message: String(warning), title: p.warningsTitle })
    }

    if (missingEnv.length > 0) {
      notify({ kind: 'warning', message: p.missingEnv(missingEnv.map(String).join(', ')), title: p.title })
    }

    if (halfInstall) {
      notify({ kind: 'warning', message: p.restDoorOff, title: p.title })
    }

    // Both inventories, because a package can carry both halves: the agent list
    // over RPC, the client list off whichever disk door is in force.
    void loadAgentPlugins(requestGateway)
    discoverRuntimePlugins()

    closePluginInstallRequest()
    openAppRoute(PLUGINS_SETTINGS_ROUTE)
  }

  const failureMessage = (kind: PluginInstallFailure, message: string) => {
    switch (kind) {
      case 'already-exists':
        // The backend's own words, verbatim — it knows what already exists.
        return message

      case 'no-identifier':
        return p.noIdentifier

      case 'unknown-action':
        return message

      case 'unreachable':
        // NOT "install failed". The clone may still be running on the gateway,
        // and telling the user it failed invites a Force retry that would
        // `rm -rf` a good install.
        return p.stillRunning
    }
  }

  return (
    <Dialog onOpenChange={value => !value && close()} open>
      <DialogContent
        className="max-w-lg"
        onOpenAutoFocus={event => {
          // A link's Install button must NOT be the focused element. Radix would
          // focus the first tabbable child, so the focus is taken by the dialog
          // itself instead — Esc and the close button still work, Enter does
          // nothing.
          if (request.origin === 'deep-link') {
            event.preventDefault()
            ;(event.currentTarget as HTMLElement | null)?.focus()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{p.title}</DialogTitle>
          <DialogDescription>{request.origin === 'deep-link' ? p.fromDeepLink : p.fromSettings}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">{p.repoLabel}</span>
            {editable ? (
              <Input
                autoFocus
                className="font-mono"
                onChange={event => setRepo(event.target.value)}
                placeholder={p.repoPlaceholder}
                spellCheck={false}
                value={repo}
              />
            ) : (
              <span className="font-mono text-sm break-all">
                {repo}
                {links?.subdir && <span className="opacity-60"> · {links.subdir}</span>}
              </span>
            )}
            {links?.browseUrl && (
              <ExternalLink className="text-xs" href={links.browseUrl} showExternalIcon>
                {p.sourceLink}
              </ExternalLink>
            )}
          </div>

          {!links && repo.trim() !== '' && <p className="text-xs text-destructive">{p.invalidIdentifier}</p>}

          {links?.insecure && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span>{p.insecureWarning(links.gitUrl)}</span>
            </div>
          )}

          {request.profile && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              {p.targetProfile}
              <Pill>{request.profile}</Pill>
            </div>
          )}

          {halfInstall && (
            <div className="flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span>{p.restDoorOff}</span>
            </div>
          )}

          {/* Rule 26. This sits above the Install button, never in a tooltip. */}
          <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-foreground">
            {p.authorityNotice}
          </p>

          {/* MJXHRM-508 fills the gap between the authority sentence and the
              switches with a declared-capability list, once the gateway returns
              one. Its landing is one component and one field on the install call
              — this dialog's layout, i18n group and error handling do not move. */}

          <label className="flex items-center justify-between gap-3 text-xs">
            <span className="flex flex-col">
              <span className="text-foreground">{p.enableAfterInstall}</span>
            </span>
            <Switch checked={enable} disabled={installing} onCheckedChange={setEnable} />
          </label>

          <label className="flex items-center justify-between gap-3 text-xs">
            <span className="flex flex-col">
              <span className="text-foreground">{p.forceReinstall}</span>
              <span className="text-muted-foreground">{p.forceReinstallHint}</span>
            </span>
            <Switch checked={force} disabled={installing} onCheckedChange={setForce} />
          </label>

          {!ready && <p className="text-xs text-muted-foreground">{p.waitingForGateway}</p>}

          {failure && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span className="break-words">{failureMessage(failure.kind, failure.message)}</span>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button disabled={installing} onClick={close} type="button" variant="ghost">
            {t.common.cancel}
          </Button>
          <Button disabled={!canInstall} onClick={() => void run()}>
            {installing ? p.installing : p.install}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
