import { useCallback, useEffect, useRef, useState } from 'react'

import { PageLoader } from '@/components/page-loader'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useI18n } from '@/i18n'
import {
  clearProfileAsset,
  configureProfile,
  describeProfile,
  getProfileAsset,
  type ProfileDescription,
  setProfileAsset
} from '@/lib/gateway-rpc'
import { AlertTriangle } from '@/lib/icons'
import { notify, notifyError } from '@/store/notifications'

import { PanelSectionLabel } from '../overlays/panel'
import { ListRow } from '../settings/primitives'

// The gateway rejects anything bigger DECODED (profiles.set_asset), so check it
// here rather than paying the upload and reading the error back.
const MAX_AVATAR_BYTES = 2 * 1024 * 1024
const AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp']

type Toggle = { name: string; enabled: boolean }

/** Names the user left ON, in the order the backend listed them. */
const enabledNames = (rows: Toggle[]) => rows.filter(row => row.enabled).map(row => row.name)

/**
 * The profile editor: one `profiles.describe` read, one `profiles.configure`
 * write, and the avatar asset pair — MJXHRM-444's typed helpers, none of which
 * REST has an equivalent for.
 *
 * Sections are sent ONLY when the user touched them. That is not an
 * optimisation: `disabledSkills` / `enabledToolsets` / `enabledMcpServers` are
 * REPLACE, and `toolsets_pinned: false` means "no list pinned, everything on" —
 * so echoing an untouched toolset list back would silently PIN it, freezing
 * today's set against every future install.
 */
export function ProfileEditor({ profileName }: { profileName: string }) {
  const { t } = useI18n()
  const p = t.profiles
  const e = p.editor
  const [description, setDescription] = useState<null | ProfileDescription>(null)
  const [loadError, setLoadError] = useState<null | string>(null)
  const [descriptionDraft, setDescriptionDraft] = useState('')
  const [skills, setSkills] = useState<Toggle[]>([])
  const [toolsets, setToolsets] = useState<Toggle[]>([])
  const [mcpServers, setMcpServers] = useState<Toggle[]>([])
  const [dirty, setDirty] = useState<Record<string, boolean>>({})
  const [saving, setSaving] = useState(false)
  const [avatar, setAvatar] = useState<null | string>(null)
  const [avatarBusy, setAvatarBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement | null>(null)
  // Only the newest request for THIS profile may write state — switching rows
  // fast otherwise paints the previous profile's config under the new name.
  const requestRef = useRef(profileName)

  const markDirty = (section: string) => setDirty(current => ({ ...current, [section]: true }))

  useEffect(() => {
    requestRef.current = profileName
    setDescription(null)
    setLoadError(null)
    setDirty({})
    setAvatar(null)

    void (async () => {
      try {
        const described = await describeProfile(profileName)

        if (requestRef.current !== profileName) {
          return
        }

        setDescription(described)
        setDescriptionDraft(described.description)
        setSkills(described.skills.map(skill => ({ name: skill.name, enabled: skill.enabled })))
        setToolsets(described.toolsets.map(toolset => ({ name: toolset.name, enabled: toolset.enabled })))
        setMcpServers(described.mcp_servers.map(server => ({ name: server.name, enabled: server.enabled })))
      } catch (err) {
        if (requestRef.current === profileName) {
          setLoadError(err instanceof Error ? err.message : e.loadFailed)
        }
      }
    })()
    void (async () => {
      try {
        // `found: false` is the normal answer for a profile with no avatar.
        const asset = await getProfileAsset(profileName)

        if (requestRef.current === profileName && asset.found && asset.data) {
          setAvatar(asset.data)
        }
      } catch {
        // A gateway too old for profiles.get_asset just shows no avatar.
      }
    })()
  }, [e, profileName])

  const save = useCallback(async () => {
    if (!description) {
      return
    }

    setSaving(true)

    try {
      const result = await configureProfile({
        name: profileName,
        ...(dirty.description ? { description: descriptionDraft } : {}),
        ...(dirty.skills ? { disabledSkills: skills.filter(row => !row.enabled).map(row => row.name) } : {}),
        ...(dirty.toolsets ? { enabledToolsets: enabledNames(toolsets) } : {}),
        ...(dirty.mcp ? { enabledMcpServers: enabledNames(mcpServers) } : {})
      })

      // Every section is applied independently and best-effort, so `ok` alone
      // cannot tell the user WHICH half of their Save was lost.
      const failed = Object.entries(result.applied)
        .filter(([, applied]) => applied === false)
        .map(([section]) => section)

      if (failed.length > 0) {
        notify({ kind: 'warning', title: e.savedPartial, message: failed.join(', ') })
      } else {
        notify({ kind: 'success', title: e.saved, message: profileName })
      }

      setDirty({})
    } catch (err) {
      notifyError(err, e.saveFailed)
    } finally {
      setSaving(false)
    }
  }, [description, descriptionDraft, dirty, e, mcpServers, profileName, skills, toolsets])

  const uploadAvatar = useCallback(
    async (file: File) => {
      if (!AVATAR_TYPES.includes(file.type)) {
        notify({ kind: 'warning', title: e.avatarRejected, message: e.avatarHint })

        return
      }

      if (file.size > MAX_AVATAR_BYTES) {
        notify({ kind: 'warning', title: e.avatarTooLarge, message: e.avatarHint })

        return
      }

      setAvatarBusy(true)

      try {
        const data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onerror = () => reject(reader.error ?? new Error('read failed'))
          reader.onload = () => resolve(String(reader.result ?? ''))
          reader.readAsDataURL(file)
        })

        await setProfileAsset({ data, name: profileName })
        setAvatar(data)
        notify({ kind: 'success', title: e.avatarSaved, message: profileName })
      } catch (err) {
        notifyError(err, e.avatarFailed)
      } finally {
        setAvatarBusy(false)
      }
    },
    [e, profileName]
  )

  const removeAvatar = useCallback(async () => {
    setAvatarBusy(true)

    try {
      await clearProfileAsset(profileName)
      setAvatar(null)
    } catch (err) {
      notifyError(err, e.avatarFailed)
    } finally {
      setAvatarBusy(false)
    }
  }, [e, profileName])

  if (loadError) {
    return (
      <section className="space-y-2">
        <PanelSectionLabel className="text-[0.7rem] tracking-[0.14em]">{e.title}</PanelSectionLabel>
        <div className="flex items-start gap-2 rounded bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>{loadError}</span>
        </div>
      </section>
    )
  }

  if (!description) {
    return <PageLoader className="min-h-32" label={e.loading} />
  }

  const anyDirty = Object.values(dirty).some(Boolean)

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <PanelSectionLabel className="text-[0.7rem] tracking-[0.14em]">{e.title}</PanelSectionLabel>
        {anyDirty && <span className="text-[0.65rem] text-muted-foreground">{p.unsavedChanges}</span>}
      </div>

      {/* Avatar. Stored on the GATEWAY, so every device on it paints the same
          image — a locally cached avatar is per-install by definition. */}
      <div className="flex items-center gap-3">
        {avatar ? (
          <img alt="" className="size-12 shrink-0 rounded-md object-cover" src={avatar} />
        ) : (
          <span className="size-12 shrink-0 rounded-md bg-muted" />
        )}
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap gap-2">
            <Button disabled={avatarBusy} onClick={() => fileRef.current?.click()} size="sm" variant="outline">
              {avatar ? e.avatarReplace : e.avatarUpload}
            </Button>
            {avatar && (
              <Button disabled={avatarBusy} onClick={() => void removeAvatar()} size="sm" variant="ghost">
                {e.avatarRemove}
              </Button>
            )}
          </div>
          <p className="text-[0.66rem] leading-4 text-muted-foreground">{e.avatarHint}</p>
        </div>
        <input
          accept={AVATAR_TYPES.join(',')}
          className="hidden"
          onChange={event => {
            // Destructured, not `files[0]`: the i18n audit reads an element
            // access off a `.files` chain as "the whole t.files.* subtree is
            // reachable" and un-baselines an unrelated orphan.
            const [file] = event.target.files ?? []
            // Reset first: picking the SAME file twice fires no change event.
            event.target.value = ''

            if (file) {
              void uploadAvatar(file)
            }
          }}
          ref={fileRef}
          type="file"
        />
      </div>

      <div className="grid gap-1.5">
        <label className="text-xs font-medium" htmlFor="profile-description">
          {e.descriptionLabel}
        </label>
        <Textarea
          id="profile-description"
          onChange={event => {
            setDescriptionDraft(event.target.value)
            markDirty('description')
          }}
          placeholder={e.descriptionPlaceholder}
          rows={2}
          value={descriptionDraft}
        />
      </div>

      <ToggleList
        emptyLabel={e.noneInstalled}
        label={p.skillsLabel}
        onToggle={(name, enabled) => {
          setSkills(rows => rows.map(row => (row.name === name ? { ...row, enabled } : row)))
          markDirty('skills')
        }}
        rows={skills}
      />

      <ToggleList
        emptyLabel={e.noneInstalled}
        hint={description.toolsets_pinned ? undefined : e.toolsetsUnpinned}
        label={e.toolsetsLabel}
        onToggle={(name, enabled) => {
          setToolsets(rows => rows.map(row => (row.name === name ? { ...row, enabled } : row)))
          markDirty('toolsets')
        }}
        rows={toolsets}
      />

      <ToggleList
        emptyLabel={e.noneInstalled}
        label={e.mcpLabel}
        onToggle={(name, enabled) => {
          setMcpServers(rows => rows.map(row => (row.name === name ? { ...row, enabled } : row)))
          markDirty('mcp')
        }}
        rows={mcpServers}
      />

      <div className="flex justify-end">
        <Button disabled={!anyDirty || saving} onClick={() => void save()} size="sm">
          {saving ? p.saving : e.save}
        </Button>
      </div>
    </section>
  )
}

function ToggleList({
  emptyLabel,
  hint,
  label,
  onToggle,
  rows
}: {
  emptyLabel: string
  hint?: string
  label: string
  onToggle: (name: string, enabled: boolean) => void
  rows: Toggle[]
}) {
  return (
    <div className="space-y-1">
      <PanelSectionLabel>{label}</PanelSectionLabel>
      {hint && <p className="text-[0.66rem] leading-4 text-muted-foreground">{hint}</p>}
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground/70">{emptyLabel}</p>
      ) : (
        rows.map(row => (
          <ListRow
            action={
              <div className="flex items-center justify-end">
                <Switch checked={row.enabled} onCheckedChange={enabled => onToggle(row.name, enabled)} />
              </div>
            }
            key={row.name}
            title={<span className="font-mono text-xs">{row.name}</span>}
          />
        ))
      )}
    </div>
  )
}
