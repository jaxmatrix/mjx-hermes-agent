import { useEffect } from 'react'

import { EmptyState, ListRow, LoadingState, Pill, SettingsContent } from '@/app/settings/primitives'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { useI18n } from '@/i18n'
import { Check } from '@/lib/icons'
import { useStore } from '@/store/atom'
import {
  $petBusy,
  $petGallery,
  $petGalleryError,
  $petGalleryStatus,
  adoptPet,
  loadPetGallery,
  setPetEnabled,
  TOGGLE
} from '@/store/pet-gallery'

import { PetSprite } from './pet-sprite'
import { PetThumb } from './pet-thumb'

// Pet gallery (K10.a): adopt / enable / disable pets. Lives under Settings → Pet.
// The animated in-app sprite (K10.b) and AI generation (K10.c) build on this.
export function PetSection() {
  const { t } = useI18n()
  const p = t.commandCenter.pets
  const gallery = useStore($petGallery)
  const status = useStore($petGalleryStatus)
  const error = useStore($petGalleryError)
  const busy = useStore($petBusy)

  useEffect(() => void loadPetGallery(), [])

  if (status === 'loading' && !gallery) {
    return <LoadingState label={p.loading} />
  }
  if (status === 'stale') {
    return (
      <SettingsContent>
        <EmptyState title={p.staleBackend} />
      </SettingsContent>
    )
  }
  if (status === 'error' && !gallery) {
    return (
      <SettingsContent>
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <span className="text-sm text-muted-foreground">{error || p.error}</span>
          <Button onClick={() => void loadPetGallery(true)} size="sm">
            {t.common.retry}
          </Button>
        </div>
      </SettingsContent>
    )
  }

  const pets = gallery?.pets ?? []

  return (
    <SettingsContent>
      {gallery?.enabled && (
        <div className="grid min-h-24 place-items-center py-4">
          <PetSprite zoom={2.4} />
        </div>
      )}

      <ListRow
        action={<Switch checked={Boolean(gallery?.enabled)} disabled={busy === TOGGLE} onCheckedChange={on => void setPetEnabled(on)} />}
        description={gallery?.enabled ? p.turnOff : p.turnOn}
        title={p.title}
      />

      {pets.length === 0 ? (
        <EmptyState title={p.noneAvailable} />
      ) : (
        <div className="pt-1">
          {pets.map(pet => {
            const active = gallery?.active === pet.slug && gallery.enabled
            return (
              <ListRow
                key={pet.slug}
                description={pet.installed ? p.installed : undefined}
                title={
                  <span className="inline-flex items-center gap-2">
                    <PetThumb slug={pet.slug} url={pet.spritesheetUrl} />
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-foreground">{pet.displayName}</span>
                      {pet.generated && <Pill>{p.generatedTag}</Pill>}
                    </span>
                  </span>
                }
                action={
                  active ? (
                    <span className="inline-flex items-center gap-1 text-sm text-primary">
                      <Check className="size-4" />
                    </span>
                  ) : (
                    <Button disabled={busy === pet.slug} onClick={() => void adoptPet(pet.slug)} size="sm" variant="outline">
                      {t.commandCenter.generatePet.adopt}
                    </Button>
                  )
                }
              />
            )
          })}
        </div>
      )}
    </SettingsContent>
  )
}
