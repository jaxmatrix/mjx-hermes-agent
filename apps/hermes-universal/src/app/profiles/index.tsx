import { useStore } from '@nanostores/react'
import type * as React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { CodeEditor } from '@/components/chat/code-editor'
import { PageLoader } from '@/components/page-loader'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { SanitizedInput } from '@/components/ui/sanitized-input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { deleteProfile, getProfileSoul, type ProfileInfo, updateProfileSoul } from '@/hermes'
import { useI18n } from '@/i18n'
import { createProfileRpc, listProfilesRich, type ProfileRosterRow } from '@/lib/gateway-rpc'
import { AlertTriangle, Save } from '@/lib/icons'
import { profileColorSoft, resolveProfileColor } from '@/lib/profile-color'
import { isValidProfileName } from '@/lib/profile-name'
import { slug } from '@/lib/sanitize'
import { normalize } from '@/lib/text'
import { cn } from '@/lib/utils'
import { useDisplayPath } from '@/store/display-home'
import { notify, notifyError } from '@/store/notifications'
import { $profileColors, profileLabel, refreshProfiles } from '@/store/profile'
import { runExportProfileFlow, runImportProfileFlow } from '@/store/profile-share'

import { useRefreshHotkey } from '../hooks/use-refresh-hotkey'
import type { OverlayVariant } from '../overlays/overlay-view'
import {
  Panel,
  PanelAddButton,
  PanelBody,
  PanelDetail,
  PanelEmpty,
  PanelHeader,
  PanelList,
  PanelListRow,
  type PanelMenuItem,
  PanelMeta,
  PanelPill,
  PanelSectionLabel
} from '../overlays/panel'

import { ProfileEditor } from './profile-editor'
import { RenameProfileDialog } from './rename-profile-dialog'

interface ProfilesViewProps {
  onClose: () => void
  // Fullscreen when hosted as a native activity screen (Android/iOS).
  variant?: OverlayVariant
}

export function ProfilesView({ onClose, variant }: ProfilesViewProps) {
  const { t } = useI18n()
  const p = t.profiles
  const [profiles, setProfiles] = useState<null | ProfileInfo[]>(null)
  // `profiles.list` (MJXHRM-444's listProfilesRich) folds each profile's running
  // worker and newest conversation into the roster read. A profile whose worker
  // is running counts as ACTIVE even with no recent human chat — reading only
  // the session list paints a busy agent as idle. Keyed by canonical name;
  // best-effort, so a gateway without the RPC just shows no activity.
  const [activity, setActivity] = useState<Record<string, ProfileRosterRow>>({})
  const [selectedName, setSelectedName] = useState<null | string>(null)
  const [query, setQuery] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [pendingRename, setPendingRename] = useState<null | ProfileInfo>(null)
  const [pendingDelete, setPendingDelete] = useState<null | ProfileInfo>(null)
  const [deleting, setDeleting] = useState(false)
  // The profile whose export is in flight. Archiving a large profile is tar +
  // filesystem work on the backend and can take a while, so the row says so.
  const [exporting, setExporting] = useState<null | string>(null)

  const refresh = useCallback(async () => {
    void listProfilesRich({ includeSessions: true })
      .then(rich => setActivity(Object.fromEntries(rich.profiles.map(row => [row.name, row]))))
      .catch(() => undefined)

    try {
      const list = await refreshProfiles()
      setProfiles(list)
      setSelectedName(current => {
        if (current && list.some(p => p.name === current)) {
          return current
        }

        return list.find(p => p.is_default)?.name ?? list[0]?.name ?? null
      })
    } catch (err) {
      notifyError(err, p.failedLoad)
    }
  }, [p])

  useRefreshHotkey(refresh)

  useEffect(() => {
    void refresh()
  }, [refresh])

  const selected = useMemo(() => {
    if (!profiles) {
      return null
    }

    return profiles.find(p => p.name === selectedName) ?? profiles[0] ?? null
  }, [profiles, selectedName])

  const visibleProfiles = useMemo(() => {
    const q = normalize(query)

    if (!profiles || !q) {
      return profiles ?? []
    }

    // Search the DISPLAY name too — a renamed default profile is findable by
    // the name the user gave it, not only by the id "default".
    return profiles.filter(
      profile =>
        profile.name.toLowerCase().includes(q) ||
        profileLabel(profile).toLowerCase().includes(q) ||
        (profile.model ?? '').toLowerCase().includes(q)
    )
  }, [profiles, query])

  // Share doors. The store owns the toasts (and the "where did it land" path),
  // so these only guard against a double-fire and refresh the list afterwards.
  const exportOne = useCallback(async (name: string) => {
    setExporting(current => current ?? name)

    try {
      await runExportProfileFlow(name)
    } finally {
      setExporting(null)
    }
  }, [])

  const importOne = useCallback(async () => {
    const name = await runImportProfileFlow()

    if (name) {
      setSelectedName(name)
      await refresh()
    }
  }, [refresh])

  const handleCreate = useCallback(
    async (name: string, cloneFrom: null | string, shareAuth: boolean) => {
      const trimmed = name.trim()

      if (!isValidProfileName(trimmed)) {
        throw new Error(p.nameHint)
      }

      // The RPC twin of POST /api/profiles, and the only one that can mirror
      // credentials or share the sign-in — REST creates a profile with a
      // comment-only .env whose first message fails with no provider.
      const created = await createProfileRpc({
        name: trimmed,
        ...(cloneFrom ? { cloneFrom } : {}),
        shareAuth
      })

      const usable = created.mirrored || shareAuth

      notify({
        kind: usable ? 'success' : 'warning',
        title: p.created,
        message: usable ? trimmed : p.editor.noCredentials
      })
      setSelectedName(trimmed)
      await refresh()
    },
    [p, refresh]
  )

  const handleConfirmDelete = useCallback(async () => {
    if (!pendingDelete) {
      return
    }

    setDeleting(true)

    try {
      await deleteProfile(pendingDelete.name)
      notify({ kind: 'success', title: p.deleted, message: pendingDelete.name })
      setPendingDelete(null)
      setSelectedName(null)
      await refresh()
    } catch (err) {
      notifyError(err, p.failedDelete)
    } finally {
      setDeleting(false)
    }
  }, [p, pendingDelete, refresh])

  return (
    <Panel closeLabel={p.close} onClose={onClose} variant={variant}>
      {!profiles ? (
        <PageLoader label={p.loading} />
      ) : profiles.length === 0 ? (
        <PanelEmpty
          action={
            <Button onClick={() => setCreateOpen(true)} size="sm">
              {p.newProfile}
            </Button>
          }
          description={p.createDesc}
          icon="organization"
          title={p.noProfiles}
        />
      ) : (
        <>
          <PanelHeader subtitle={p.count(profiles.length)} title={p.title} />
          <PanelBody>
            <PanelList
              onSearchChange={setQuery}
              searchLabel={p.search}
              searchPlaceholder={p.search}
              searchValue={query}
            >
              {visibleProfiles.map(profile => (
                <ProfileRow
                  active={selected?.name === profile.name}
                  activity={activity[profile.name]}
                  key={profile.name}
                  menuItems={[
                    // Export is offered for the default profile too — it is
                    // the one every single-profile user actually has.
                    {
                      icon: 'package',
                      label: exporting === profile.name ? p.exporting : p.exportProfile,
                      onSelect: () => void exportOne(profile.name)
                    },
                    // Renaming the DEFAULT profile sets a presentation-only
                    // display name — the canonical id stays "default", so the
                    // directory move (and the delete) stay named-only.
                    { icon: 'edit', label: p.renameMenu, onSelect: () => setPendingRename(profile) },
                    ...(profile.is_default
                      ? []
                      : [
                          {
                            icon: 'trash',
                            label: t.common.delete,
                            onSelect: () => setPendingDelete(profile),
                            tone: 'danger' as const
                          }
                        ])
                  ]}
                  onSelect={() => setSelectedName(profile.name)}
                  profile={profile}
                />
              ))}
              <PanelAddButton label={p.newProfile} onClick={() => setCreateOpen(true)} />
              {/* Import lands beside create: a shared bundle is the other way a
                  profile comes into existence. */}
              <PanelAddButton icon="cloud-download" label={p.importProfile} onClick={() => void importOne()} />
            </PanelList>

            {selected ? (
              <ProfileDetail activity={activity[selected.name]} key={selected.name} profile={selected} />
            ) : (
              <PanelEmpty description={p.selectPrompt} icon="account" />
            )}
          </PanelBody>
        </>
      )}

      <RenameProfileDialog
        currentName={pendingRename?.name ?? ''}
        isDefault={pendingRename?.is_default ?? false}
        onClose={() => setPendingRename(null)}
        onRenamed={async newName => {
          const renamed = pendingRename

          notify({ kind: 'success', title: p.renamed, message: `${renamed?.name ?? ''} \u2192 ${newName}` })
          // A default-profile rename only sets a display name; its canonical id
          // (and therefore the selection key) is still "default".
          setSelectedName(renamed?.is_default ? renamed.name : newName)
          await refresh()
        }}
        open={pendingRename !== null}
      />

      <CreateProfileDialog
        onClose={() => setCreateOpen(false)}
        onCreate={async (name, cloneFrom, shareAuth) => handleCreate(name, cloneFrom, shareAuth)}
        open={createOpen}
        profiles={profiles ?? []}
      />

      <Dialog onOpenChange={open => !open && !deleting && setPendingDelete(null)} open={pendingDelete !== null}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{p.deleteTitle}</DialogTitle>
            <DialogDescription>
              {pendingDelete ? (
                <>
                  {p.deleteDescPrefix}
                  <span className="font-medium text-foreground">{pendingDelete.name}</span>
                  {p.deleteDescMid}
                  <span className="font-mono text-xs">{pendingDelete.path}</span>
                  {p.deleteDescSuffix}
                </>
              ) : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button disabled={deleting} onClick={() => setPendingDelete(null)} variant="outline">
              {t.common.cancel}
            </Button>
            <Button disabled={deleting} onClick={() => void handleConfirmDelete()} variant="destructive">
              {deleting ? p.deleting : t.common.delete}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Panel>
  )
}

function ProfileRow({
  active,
  activity,
  menuItems,
  onSelect,
  profile
}: {
  active: boolean
  activity?: ProfileRosterRow
  menuItems?: PanelMenuItem[]
  onSelect: () => void
  profile: ProfileInfo
}) {
  const { t } = useI18n()
  const colors = useStore($profileColors)

  return (
    <PanelListRow
      active={active}
      lead={
        <ProfileGlyph
          color={resolveProfileColor(profile.name, colors)}
          isDefault={profile.is_default}
          name={profile.name}
        />
      }
      menuItems={menuItems}
      menuLabel={profileLabel(profile)}
      meta={
        // A running worker is the "this agent is busy right now" signal the
        // session list alone cannot give: a profile grinding through a kanban
        // job has no recent HUMAN chat and would otherwise read as idle.
        activity?.worker_session ? <span className="text-primary">{t.profiles.editor.working}</span> : undefined
      }
      onSelect={onSelect}
      rowKey={profile.name}
      title={profileLabel(profile)}
    />
  )
}

// Leading glyph for a profile row, mirroring the sidebar rail: the default
// profile gets the `home` icon; named profiles get a soft color-tinted square
// with their initial in the profile's color.
function ProfileGlyph({ color, isDefault, name }: { color: null | string; isDefault: boolean; name: string }) {
  if (isDefault) {
    return <Codicon className="shrink-0 text-muted-foreground/70" name="home" size="0.9rem" />
  }

  const hue = color ?? 'var(--ui-text-quaternary)'

  const initial =
    name
      .replace(/[^a-z0-9]/gi, '')
      .charAt(0)
      .toUpperCase() || '?'

  return (
    <span
      aria-hidden="true"
      className="grid size-4 shrink-0 place-items-center rounded-[3px] text-[0.5rem] font-semibold uppercase leading-none"
      style={{ backgroundColor: profileColorSoft(hue, 22), color: color ?? undefined }}
    >
      {initial}
    </span>
  )
}

function ProfileDetail({ activity, profile }: { activity?: ProfileRosterRow; profile: ProfileInfo }) {
  const { t } = useI18n()
  const p = t.profiles
  // A profile lives under the GATEWAY's HERMES_HOME, so `~` here is the gateway
  // user's home — never this client's (MJXHRM-394).
  const displayPath = useDisplayPath()

  return (
    <PanelDetail>
      <header className="space-y-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[0.95rem] font-semibold tracking-tight text-foreground">{profileLabel(profile)}</h3>
            {profile.is_default && <PanelPill tone="good">{p.defaultBadge}</PanelPill>}
            {profile.has_env && <PanelPill tone="muted">.env</PanelPill>}
          </div>
          <p
            className="mt-1 truncate font-mono text-[0.66rem] text-muted-foreground/55"
            title={displayPath(profile.path)}
          >
            {displayPath(profile.path)}
          </p>
        </div>

        <PanelMeta
          rows={[
            {
              label: p.modelLabel,
              value: profile.model ? (
                <span className="font-mono">
                  {profile.model}
                  {profile.provider ? <span className="text-muted-foreground/55"> · {profile.provider}</span> : null}
                </span>
              ) : (
                <span className="text-muted-foreground/55">{p.notSet}</span>
              )
            },
            { label: p.skillsLabel, value: profile.skill_count },
            // What this agent is actually on. The ROOT title, not the live
            // tip's: a tip is retitled as the conversation is compressed, so
            // the root is the name the work was given.
            ...(activity?.worker_session || activity?.preferred_session
              ? [
                  {
                    label: p.editor.working,
                    value: activity.preferred_session?.root_title || activity.worker_session?.title || p.notSet
                  }
                ]
              : [])
          ]}
        />
      </header>

      <ProfileEditor profileName={profile.name} />

      <SoulEditor profileName={profile.name} />
    </PanelDetail>
  )
}

function SoulEditor({ profileName }: { profileName: string }) {
  const { t } = useI18n()
  const p = t.profiles
  const [content, setContent] = useState('')
  const [original, setOriginal] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<null | string>(null)
  const requestRef = useRef<string>(profileName)

  useEffect(() => {
    requestRef.current = profileName
    setLoading(true)
    setError(null)
    setContent('')
    setOriginal('')

    void (async () => {
      try {
        const soul = await getProfileSoul(profileName)

        if (requestRef.current === profileName) {
          setContent(soul.content)
          setOriginal(soul.content)
        }
      } catch (err) {
        if (requestRef.current === profileName) {
          setError(err instanceof Error ? err.message : p.failedLoadSoul)
        }
      } finally {
        if (requestRef.current === profileName) {
          setLoading(false)
        }
      }
    })()
  }, [p, profileName])

  const dirty = content !== original

  async function handleSave() {
    setSaving(true)
    setError(null)

    try {
      await updateProfileSoul(profileName, content)
      setOriginal(content)
      notify({ kind: 'success', title: p.soulSaved, message: profileName })
    } catch (err) {
      setError(err instanceof Error ? err.message : p.failedSaveSoul)
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <PanelSectionLabel className="text-[0.7rem] tracking-[0.14em]">SOUL.md</PanelSectionLabel>
          <p className="text-xs text-muted-foreground">{p.soulDesc}</p>
        </div>
        {dirty && <span className="text-[0.65rem] text-muted-foreground">{p.unsavedChanges}</span>}
      </div>

      {loading ? (
        <PageLoader className="min-h-44" label={p.loadingSoul} />
      ) : (
        <div className="min-h-48">
          <CodeEditor
            filePath="SOUL.md"
            framed
            initialValue={content}
            key={profileName}
            onChange={setContent}
            onSave={() => void handleSave()}
          />
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 rounded bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="flex justify-end">
        <Button disabled={!dirty || saving || loading} onClick={() => void handleSave()} size="sm">
          <Save />
          {saving ? p.saving : p.saveSoul}
        </Button>
      </div>
    </section>
  )
}

function CreateProfileDialog({
  onClose,
  onCreate,
  open,
  profiles
}: {
  onClose: () => void
  onCreate: (name: string, cloneFrom: null | string, shareAuth: boolean) => Promise<void>
  open: boolean
  profiles: ProfileInfo[]
}) {
  const { t } = useI18n()
  const p = t.profiles
  const [name, setName] = useState('')
  const [cloneFrom, setCloneFrom] = useState<null | string>('default')
  const [shareAuth, setShareAuth] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<null | string>(null)

  useEffect(() => {
    if (!open) {
      return
    }

    setName('')
    setCloneFrom('default')
    setShareAuth(true)
    setError(null)
    setSaving(false)
  }, [open])

  const trimmed = name.trim()
  const invalid = trimmed !== '' && !isValidProfileName(trimmed)

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()

    if (!trimmed || invalid) {
      setError(invalid ? p.invalidName(p.nameHint) : p.nameRequired)

      return
    }

    setSaving(true)
    setError(null)

    try {
      await onCreate(trimmed, cloneFrom, shareAuth)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : p.failedCreate)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog onOpenChange={value => !value && !saving && onClose()} open={open}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{p.newProfile}</DialogTitle>
          <DialogDescription>{p.createDesc}</DialogDescription>
        </DialogHeader>

        <form className="grid gap-4" onSubmit={handleSubmit}>
          <div className="grid gap-1.5">
            <label className="text-xs font-medium" htmlFor="new-profile-name">
              {p.nameLabel}
            </label>
            <SanitizedInput
              aria-invalid={invalid}
              autoFocus
              id="new-profile-name"
              onValueChange={setName}
              placeholder="my-profile"
              sanitize={slug}
              value={name}
            />
            <p className={cn('text-[0.66rem] leading-4', invalid ? 'text-destructive' : 'text-muted-foreground')}>
              {p.nameHint}
            </p>
          </div>

          <div className="grid gap-1.5">
            <label className="text-xs font-medium" htmlFor="new-profile-clone-from">
              {p.cloneFrom}
            </label>
            <Select
              onValueChange={value => setCloneFrom(value === '__none__' ? null : value)}
              value={cloneFrom ?? '__none__'}
            >
              <SelectTrigger className="h-9 rounded-md" id="new-profile-clone-from">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">{p.cloneFromNone}</SelectItem>
                {profiles.map(profile => (
                  <SelectItem key={profile.name} value={profile.name}>
                    {profile.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{p.cloneFromDesc}</p>
          </div>

          <div className="grid gap-1.5">
            <label className="flex items-center gap-2 text-xs font-medium">
              <Switch checked={shareAuth} onCheckedChange={setShareAuth} size="xs" />
              {p.editor.shareSignIn}
            </label>
            <p className="text-xs text-muted-foreground">{p.editor.shareSignInHint}</p>
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <DialogFooter>
            <Button disabled={saving} onClick={onClose} type="button" variant="outline">
              {t.common.cancel}
            </Button>
            <Button disabled={saving || !trimmed || invalid} type="submit">
              {saving ? p.creating : p.createAction}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
