import { useEffect, useState } from 'react'

import { EmptyState, ListRow, LoadingState, Pill, SettingsContent } from '@/app/settings/primitives'
import { SidebarTrigger } from '@/app/shell/sidebar'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useI18n } from '@/i18n'
import { MoreVertical, Plus } from '@/lib/icons'
import { useStore } from '@/store/atom'
import { notify } from '@/store/notifications'
import {
  $profiles,
  $profilesError,
  $profilesLoading,
  createProfileLocal,
  isValidProfileName,
  refreshProfiles,
  removeProfile,
  renameProfileLocal
} from '@/store/profiles'
import type { ProfileInfo } from '@/types/hermes'

import { SoulSheet } from './soul-sheet'

const CLONE_NONE = '__none__'

export function ProfilesScreen() {
  const { t } = useI18n()
  const p = t.profiles
  const profiles = useStore($profiles)
  const loading = useStore($profilesLoading)
  const error = useStore($profilesError)

  const [creating, setCreating] = useState(false)
  const [createName, setCreateName] = useState('')
  const [cloneFrom, setCloneFrom] = useState(CLONE_NONE)
  const [busy, setBusy] = useState(false)

  const [renaming, setRenaming] = useState<ProfileInfo | null>(null)
  const [newName, setNewName] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<ProfileInfo | null>(null)
  const [soulFor, setSoulFor] = useState<string | null>(null)

  useEffect(() => void refreshProfiles(), [])

  const create = async () => {
    if (!isValidProfileName(createName)) {
      notify({ kind: 'warning', message: p.invalidName(p.nameHint) })
      return
    }
    setBusy(true)
    const ok = await createProfileLocal({
      name: createName.trim(),
      clone_from: cloneFrom === CLONE_NONE ? null : cloneFrom
    })
    setBusy(false)
    if (ok) {
      notify({ kind: 'success', message: p.created })
      setCreating(false)
      setCreateName('')
      setCloneFrom(CLONE_NONE)
    }
  }

  const rename = async () => {
    if (!renaming || !isValidProfileName(newName)) {
      notify({ kind: 'warning', message: p.invalidName(p.nameHint) })
      return
    }
    setBusy(true)
    const ok = await renameProfileLocal(renaming.name, newName.trim())
    setBusy(false)
    if (ok) {
      notify({ kind: 'success', message: p.renamed })
      setRenaming(null)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-border p-3">
        <SidebarTrigger className="md:hidden" />
        <h1 className="min-w-0 flex-1 truncate text-base font-semibold text-foreground">{p.title}</h1>
        <Button aria-label={p.newProfile} onClick={() => setCreating(true)} size="icon-sm" variant="ghost">
          <Plus className="size-5" />
        </Button>
      </header>

      {loading && profiles.length === 0 ? (
        <LoadingState label={p.loading} />
      ) : error && profiles.length === 0 ? (
        <SettingsContent>
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <span className="text-sm text-muted-foreground">{p.failedLoad}</span>
            <Button onClick={() => void refreshProfiles()} size="sm">
              {t.common.retry}
            </Button>
          </div>
        </SettingsContent>
      ) : profiles.length === 0 ? (
        <SettingsContent>
          <EmptyState title={p.noProfiles} />
        </SettingsContent>
      ) : (
        <SettingsContent>
          <div className="pt-1">
            {profiles.map(profile => (
              <ListRow
                key={profile.name}
                description={`${profile.model ?? p.notSet} · ${p.skills(profile.skill_count)}`}
                title={
                  <span className="inline-flex items-center gap-2">
                    <span className="truncate">{profile.name}</span>
                    {profile.is_default && <Pill>{p.defaultBadge}</Pill>}
                  </span>
                }
                action={
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button aria-label={p.actionsFor(profile.name)} size="icon-sm" variant="ghost">
                        <MoreVertical className="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => setSoulFor(profile.name)}>{p.editSoul}</DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() => {
                          setRenaming(profile)
                          setNewName(profile.name)
                        }}
                      >
                        {p.renameMenu}
                      </DropdownMenuItem>
                      {!profile.is_default && (
                        <DropdownMenuItem onSelect={() => setConfirmDelete(profile)} variant="destructive">
                          {p.deleteTitle}
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                }
              />
            ))}
          </div>
        </SettingsContent>
      )}

      {/* Create */}
      <Dialog onOpenChange={setCreating} open={creating}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{p.newProfile}</DialogTitle>
            <DialogDescription>{p.createDesc}</DialogDescription>
          </DialogHeader>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">{p.nameLabel}</span>
            <Input onChange={e => setCreateName(e.target.value)} placeholder="research" value={createName} />
            <span className="mt-1 block text-xs text-muted-foreground">{p.nameHint}</span>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">{p.cloneFrom}</span>
            <Select onValueChange={setCloneFrom} value={cloneFrom}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={CLONE_NONE}>{p.cloneFromNone}</SelectItem>
                {profiles.map(profile => (
                  <SelectItem key={profile.name} value={profile.name}>
                    {profile.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost">{t.common.cancel}</Button>
            </DialogClose>
            <Button disabled={busy} onClick={() => void create()}>
              {p.createAction}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rename */}
      <Dialog onOpenChange={open => !open && setRenaming(null)} open={renaming !== null}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{p.renameTitle}</DialogTitle>
          </DialogHeader>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">{p.newNameLabel}</span>
            <Input onChange={e => setNewName(e.target.value)} value={newName} />
          </label>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost">{t.common.cancel}</Button>
            </DialogClose>
            <Button disabled={busy} onClick={() => void rename()}>
              {p.rename}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete */}
      <Dialog onOpenChange={open => !open && setConfirmDelete(null)} open={confirmDelete !== null}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{p.deleteTitle}</DialogTitle>
            <DialogDescription>
              {p.deleteDescPrefix}
              <span className="font-medium">{confirmDelete?.name}</span>
              {p.deleteDescMid}
              <span className="font-mono text-xs">{confirmDelete?.path}</span>
              {p.deleteDescSuffix}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost">{t.common.cancel}</Button>
            </DialogClose>
            <Button
              onClick={() => {
                if (confirmDelete) {
                  void removeProfile(confirmDelete.name)
                  notify({ kind: 'success', message: p.deleted })
                }
                setConfirmDelete(null)
              }}
              variant="destructive"
            >
              {p.deleteTitle}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SoulSheet name={soulFor} onOpenChange={open => !open && setSoulFor(null)} open={soulFor !== null} />
    </div>
  )
}
