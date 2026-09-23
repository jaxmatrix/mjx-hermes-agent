import { useEffect, useState } from 'react'

import { SegmentedControl } from '@/components/ui/segmented-control'
import { useI18n } from '@/i18n'
import { triggerHaptic } from '@/lib/haptics'
import {
  type GlassMaterial,
  glassMaterialForPicker,
  type GlassScope,
  TRANSLUCENCY_STEP
} from '@/lib/translucency-model'
import { useStore } from '@/store/atom'
import {
  $glassCapabilities,
  $translucency,
  beginTranslucencyPeek,
  endTranslucencyPeek,
  glassAvailable,
  pulseTranslucencyPeek,
  resetTranslucencyPeek,
  setTranslucency,
  setTranslucencyFade,
  setTranslucencyMaterial,
  setTranslucencyMode,
  setTranslucencyScope,
  translucencyAvailable
} from '@/store/translucency'

import { ListRow } from './primitives'
import { settingRowElementId } from './settings-search'

/**
 * The Appearance page's translucency rows: mode, tint, frost, area, fade.
 *
 * Gated on what Rust says this OS can do, never on `IS_DESKTOP` — Linux does
 * Clear and not Glass, an old Windows does neither, and a phone has no window
 * manager to show through, so it gets no row at all rather than a disabled one.
 *
 * "Off" is a UI convenience over the two-mode model, not a third mode: it sets
 * the tint to zero (which `glassActive` already reads as off) and remembers the
 * previous value for the session so toggling back does not lose the tuning.
 * "Set the slider to zero" is not a discoverable way to turn a feature off.
 *
 * While a control is held the whole Settings overlay ghosts out of the way, so
 * the live window is the preview. The peek counter is RESET on unmount: a
 * pointer held when Escape closes the overlay never delivers its `pointerup`,
 * and a stuck hold would ghost the next overlay too.
 */

const SLIDER_CLASS = 'h-1 w-40 cursor-pointer appearance-none rounded-full bg-(--ui-stroke-tertiary)'

const READOUT_CLASS =
  'w-9 text-end text-[length:var(--conversation-caption-font-size)] tabular-nums text-(--ui-text-tertiary)'

type ModeOption = 'clear' | 'glass' | 'off'

function Slider({ label, onChange, value }: { label: string; onChange: (value: number) => void; value: number }) {
  return (
    <div className="flex items-center gap-3">
      <input
        aria-label={label}
        className={SLIDER_CLASS}
        max={100}
        min={0}
        onChange={event => {
          triggerHaptic('selection')
          onChange(Number(event.target.value))
        }}
        onPointerCancel={endTranslucencyPeek}
        onPointerDown={beginTranslucencyPeek}
        onPointerUp={endTranslucencyPeek}
        step={TRANSLUCENCY_STEP}
        style={{ accentColor: 'var(--dt-primary)' }}
        type="range"
        value={value}
      />
      <span className={READOUT_CLASS}>{value}%</span>
    </div>
  )
}

export function TranslucencySettings() {
  const { t } = useI18n()
  const a = t.settings.appearance
  const g = a.glass
  const state = useStore($translucency)
  const capabilities = useStore($glassCapabilities)
  // Session-scoped, so turning translucency off and on again lands back where it
  // was rather than at zero.
  const [rememberedTint, setRememberedTint] = useState(50)

  useEffect(() => resetTranslucencyPeek, [])

  if (!translucencyAvailable(capabilities)) {
    return null
  }

  const glassOk = glassAvailable(capabilities)
  const off = state.intensity === 0
  const mode: ModeOption = off ? 'off' : state.mode
  const glassOn = mode === 'glass'

  const modeOptions: readonly { id: ModeOption; label: string }[] = [
    { id: 'off', label: g.modeOff },
    { id: 'clear', label: g.modeClear },
    ...(glassOk ? [{ id: 'glass' as const, label: g.modeGlass }] : [])
  ]

  const chooseMode = (next: ModeOption): void => {
    triggerHaptic('selection')
    pulseTranslucencyPeek()

    if (next === 'off') {
      if (state.intensity > 0) {
        setRememberedTint(state.intensity)
      }

      setTranslucency(0)

      return
    }

    setTranslucencyMode(next)

    if (state.intensity === 0) {
      setTranslucency(rememberedTint)
    }
  }

  // A note only where the platform is taking something away. `osBuild` names the
  // build so "glass is missing" is answerable rather than mysterious.
  const modeNote = glassOk
    ? null
    : capabilities?.platform === 'windows'
      ? g.unsupportedWindows(String(capabilities.osBuild ?? '—'))
      : g.unsupportedLinux

  const frostOptions = (capabilities?.materials ?? []).map(material => ({
    id: material,
    label: g.frost[material === 'under-window' ? 'underWindow' : material]
  }))

  const areaOptions = [
    { id: 'window', label: g.areaWindow },
    { id: 'sidebar', label: g.areaSidebar }
  ] as const satisfies readonly { id: GlassScope; label: string }[]

  return (
    <div data-translucency-peek-scope="">
      <ListRow
        action={<SegmentedControl onChange={chooseMode} options={modeOptions} value={mode} />}
        description={
          <>
            {mode === 'clear' ? g.clearDesc : a.translucencyDesc}
            {modeNote && <div className="mt-1">{modeNote}</div>}
          </>
        }
        id={settingRowElementId('appearance.translucency')}
        title={a.translucencyTitle}
      />

      {mode !== 'off' && (
        <ListRow
          action={<Slider label={g.tintTitle} onChange={setTranslucency} value={state.intensity} />}
          description={g.tintDesc}
          id={settingRowElementId('appearance.tint')}
          title={g.tintTitle}
        />
      )}

      {glassOn && frostOptions.length > 0 && (
        <ListRow
          action={
            <SegmentedControl
              onChange={(material: GlassMaterial) => {
                triggerHaptic('selection')
                pulseTranslucencyPeek()
                setTranslucencyMaterial(material)
              }}
              options={frostOptions}
              // A frost saved on a Mac that this OS folds onto another rung is
              // HIGHLIGHTED as the rung it renders as, and left unrewritten.
              value={glassMaterialForPicker(state.material, capabilities?.platform === 'windows')}
            />
          }
          description={g.frostDesc}
          id={settingRowElementId('appearance.frost')}
          title={g.frostTitle}
        />
      )}

      {glassOn && (
        <ListRow
          action={
            <SegmentedControl
              onChange={(scope: GlassScope) => {
                triggerHaptic('selection')
                pulseTranslucencyPeek()
                setTranslucencyScope(scope)
              }}
              options={areaOptions}
              value={state.scope}
            />
          }
          id={settingRowElementId('appearance.area')}
          title={g.areaTitle}
        />
      )}

      {glassOn && (
        <ListRow
          action={<Slider label={g.fadeTitle} onChange={setTranslucencyFade} value={state.fade} />}
          description={g.fadeDesc}
          id={settingRowElementId('appearance.fade')}
          title={g.fadeTitle}
        />
      )}
    </div>
  )
}
