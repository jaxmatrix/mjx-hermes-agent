import { useEffect, useState } from 'react'

import { EmptyState, ListRow, LoadingState, Pill, SectionHeading, SettingsContent } from '@/app/settings/primitives'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { useI18n } from '@/i18n'
import { Loader2, Paw } from '@/lib/icons'
import { selectableCardClass } from '@/lib/selectable-card'
import { normalize } from '@/lib/text'
import { cn } from '@/lib/utils'
import { useStore } from '@/store/atom'
import { $petInfo, $petRoam, setPetRoam } from '@/store/pet'
import {
  $petBusy,
  $petGallery,
  $petGalleryStatus,
  adoptPet,
  loadPetGallery,
  PET_SCALE_DEFAULT,
  PET_SCALE_MAX,
  PET_SCALE_MIN,
  setPetEnabled,
  setPetScale
} from '@/store/pet-gallery'

import { PetGenerateSheet } from './pet-generate-sheet'
import { PetThumb } from './pet-thumb'

// Shared search-input chrome (matches the theme grid's search on Appearance).
const SEARCH_CHROME =
  'w-full rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-bg-quinary) px-3 py-1.5 text-[length:var(--conversation-caption-font-size)] outline-none placeholder:text-(--ui-text-tertiary) focus:border-(--ui-stroke-secondary)'

// Pet settings, laid out like the desktop `PetSettings` (nested at the bottom of
// Appearance): enable + choose-a-pet grid, size slider, roam toggle. `PetPanel`
// is chrome-free so it can nest inside another SettingsContent.
export function PetPanel() {
  const { t } = useI18n()
  const p = t.settings.appearance.pet
  const gallery = useStore($petGallery)
  const status = useStore($petGalleryStatus)
  const busy = useStore($petBusy)
  const petInfo = useStore($petInfo)
  const roam = useStore($petRoam)
  const [generateOpen, setGenerateOpen] = useState(false)
  const [query, setQuery] = useState('')

  useEffect(() => void loadPetGallery(), [])

  const enabled = gallery?.enabled ?? false
  const scale = petInfo.scale ?? PET_SCALE_DEFAULT
  const active = gallery?.active ?? ''
  const pets = gallery?.pets ?? []
  const q = normalize(query)
  const shown = q ? pets.filter(pt => normalize(pt.displayName).includes(q) || normalize(pt.slug).includes(q)) : pets

  const onOff = [
    { id: 'off', label: p.off },
    { id: 'on', label: p.on }
  ] as const

  return (
    <>
      <SectionHeading icon={Paw} title={p.title} />
      <p className="max-w-2xl text-[length:var(--conversation-caption-font-size)] leading-(--conversation-caption-line-height) text-(--ui-text-tertiary)">
        {p.intro}
      </p>
      {status === 'stale' && (
        <p className="mt-2 text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">
          {p.restartHint}
        </p>
      )}

      <div className="mt-2">
        <ListRow
          below={
            <>
              <input
                className={cn('mt-3', SEARCH_CHROME)}
                onChange={event => setQuery(event.target.value)}
                placeholder={p.searchPlaceholder}
                spellCheck={false}
                value={query}
              />
              <div className="mt-3 h-72 overflow-y-auto pr-1">
                {shown.length === 0 ? (
                  <p className="text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">
                    {q ? p.noMatch(query.trim()) : p.unreachable}
                  </p>
                ) : (
                  <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                    {shown.map(pet => {
                      const isActive = enabled && active === pet.slug
                      const isBusy = busy === pet.slug
                      return (
                        <button
                          className={cn(
                            'flex w-full items-center gap-2.5 px-2.5 py-2 text-left disabled:opacity-50',
                            selectableCardClass({ active: isActive, prominent: pet.installed })
                          )}
                          disabled={isBusy}
                          key={pet.slug}
                          onClick={() => void adoptPet(pet.slug)}
                          type="button"
                        >
                          <PetThumb slug={pet.slug} url={pet.spritesheetUrl} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium text-foreground">{pet.displayName}</span>
                            {pet.generated && <Pill>{p.generatedTag}</Pill>}
                          </span>
                          {isBusy && <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
              {/* <div className="mt-2"> */}
              {/*   <Button className="w-full" onClick={() => setGenerateOpen(true)} variant="outline"> */}
              {/*     <Sparkles className="size-4" /> */}
              {/*     {t.commandCenter.generatePet.title} */}
              {/*   </Button> */}
              {/* </div> */}
            </>
          }
          description={p.chooseDesc}
          title={
            <div className="flex items-center justify-between gap-3">
              <span>{p.chooseTitle}</span>
              <SegmentedControl onChange={id => void setPetEnabled(id === 'on')} options={onOff} value={enabled ? 'on' : 'off'} />
            </div>
          }
          wide
        />

        {enabled && (
          <ListRow
            action={
              <div className="flex items-center gap-3">
                <input
                  aria-label={p.scaleTitle}
                  className="h-1 w-40 cursor-pointer appearance-none rounded-full bg-(--ui-stroke-tertiary)"
                  max={PET_SCALE_MAX}
                  min={PET_SCALE_MIN}
                  onChange={event => setPetScale(Number(event.target.value))}
                  step={0.05}
                  style={{ accentColor: 'var(--dt-primary)' }}
                  type="range"
                  value={scale}
                />
                <span className="w-9 text-right text-[length:var(--conversation-caption-font-size)] tabular-nums text-(--ui-text-tertiary)">
                  {`${Math.round(scale * 100)}%`}
                </span>
              </div>
            }
            description={p.scaleDesc}
            title={p.scaleTitle}
          />
        )}

        {enabled && (
          <ListRow
            action={<SegmentedControl onChange={id => setPetRoam(id === 'on')} options={onOff} value={roam ? 'on' : 'off'} />}
            description={p.roamDesc}
            title={p.roamTitle}
          />
        )}
      </div>

      <PetGenerateSheet onOpenChange={setGenerateOpen} open={generateOpen} />
    </>
  )
}

// Standalone route wrapper (kept for the `/settings/pet` deep-link).
export function PetSection() {
  const { t } = useI18n()
  const status = useStore($petGalleryStatus)
  const gallery = useStore($petGallery)

  if (status === 'loading' && !gallery) {
    return <LoadingState label={t.commandCenter.pets.loading} />
  }
  if (status === 'error' && !gallery) {
    return (
      <SettingsContent>
        <EmptyState title={t.commandCenter.pets.error} />
      </SettingsContent>
    )
  }

  return (
    <SettingsContent>
      <PetPanel />
    </SettingsContent>
  )
}
