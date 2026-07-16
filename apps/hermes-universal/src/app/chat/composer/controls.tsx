import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { iconSize, Layers3, Loader2, Square, Volume2, VolumeX } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { triggerHaptic } from '@/store/haptics'

import { ModelPill } from './model-pill'
import type { VoiceStatus } from './types'

// Adapted from apps/desktop/src/app/chat/composer/controls.tsx. Universal has no
// full voice-conversation loop or steer RPC, so the ConversationPill / steering-
// wheel button / "start voice conversation" primary are dropped — the row is
// [ModelPill] [Dictation] [AutoSpeak] [Primary send/stop/queue].

export const ICON_BTN = 'size-(--composer-control-size) shrink-0 rounded-md'
export const GHOST_ICON_BTN = cn(
  ICON_BTN,
  'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
)
// Send primary: solid foreground-on-background circle (black-on-white in light,
// white-on-black in dark) — the high-contrast CTA that visually dominates the row.
export const PRIMARY_ICON_BTN = cn(
  'size-(--composer-control-primary-size,var(--composer-control-size)) shrink-0 rounded-full p-0',
  'bg-foreground text-background hover:bg-foreground/90',
  'disabled:bg-foreground/30 disabled:text-background disabled:opacity-100'
)

export function ComposerControls({
  autoSpeak,
  busy,
  busyAction,
  canSubmit,
  compactModelPill = false,
  disabled,
  dictationActive,
  dictationEnabled,
  dictationStatus,
  onDictate,
  onToggleAutoSpeak
}: {
  autoSpeak: boolean
  busy: boolean
  busyAction: 'queue' | 'stop'
  canSubmit: boolean
  compactModelPill?: boolean
  disabled: boolean
  dictationActive: boolean
  dictationEnabled: boolean
  dictationStatus: VoiceStatus
  onDictate: () => void
  onToggleAutoSpeak: () => void
}) {
  const { t } = useI18n()
  const c = t.composer

  return (
    <div className="ml-auto flex shrink-0 items-center gap-(--composer-control-gap)">
      <ModelPill compact={compactModelPill} disabled={disabled} />
      <DictationButton
        active={dictationActive}
        disabled={disabled}
        enabled={dictationEnabled}
        onToggle={onDictate}
        status={dictationStatus}
      />
      <AutoSpeakButton active={autoSpeak} disabled={disabled} onToggle={onToggleAutoSpeak} />
      <Tip label={busy ? (busyAction === 'queue' ? c.queueMessage : c.stop) : c.send}>
        <Button
          aria-label={busy ? (busyAction === 'queue' ? c.queueMessage : c.stop) : c.send}
          className={PRIMARY_ICON_BTN}
          disabled={disabled || !canSubmit}
          type="submit"
        >
          {busy ? (
            busyAction === 'queue' ? (
              <Layers3 className={iconSize.sm} />
            ) : (
              <span className="block size-2.5 rounded-[0.1875rem] bg-current" />
            )
          ) : (
            <Codicon name="arrow-up" size="0.875rem" />
          )}
        </Button>
      </Tip>
    </div>
  )
}

// Pure-TTS toggle: type normally, but have every assistant reply read aloud.
// Filled/accent when on.
function AutoSpeakButton({ active, disabled, onToggle }: { active: boolean; disabled: boolean; onToggle: () => void }) {
  const { t } = useI18n()
  const c = t.composer
  const label = active ? c.stopSpeakingReplies : c.speakReplies

  return (
    <Tip label={label}>
      <Button
        aria-label={label}
        aria-pressed={active}
        className={cn(
          GHOST_ICON_BTN,
          'p-0',
          active && 'bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary'
        )}
        disabled={disabled}
        onClick={() => {
          void triggerHaptic('select')
          onToggle()
        }}
        size="icon"
        type="button"
        variant="ghost"
      >
        {active ? <Volume2 className={iconSize.sm} /> : <VolumeX className={iconSize.sm} />}
      </Button>
    </Tip>
  )
}

function DictationButton({
  active,
  disabled,
  enabled,
  status,
  onToggle
}: {
  active: boolean
  disabled: boolean
  enabled: boolean
  status: VoiceStatus
  onToggle: () => void
}) {
  const { t } = useI18n()
  const c = t.composer

  const aria =
    status === 'recording' ? c.stopDictation : status === 'transcribing' ? c.transcribingDictation : c.voiceDictation

  return (
    <Tip label={aria}>
      <Button
        aria-label={aria}
        aria-pressed={active}
        className={cn(
          GHOST_ICON_BTN,
          'p-0',
          'data-[active=true]:bg-accent data-[active=true]:text-foreground',
          status === 'recording' && 'bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary',
          status === 'transcribing' && 'bg-primary/10 text-primary'
        )}
        data-active={active}
        disabled={disabled || !enabled || status === 'transcribing'}
        onClick={() => {
          void triggerHaptic('select')
          onToggle()
        }}
        size="icon"
        type="button"
        variant="ghost"
      >
        {status === 'recording' ? (
          <Square className={cn('fill-current', iconSize.xs)} />
        ) : status === 'transcribing' ? (
          <Loader2 className={cn('animate-spin', iconSize.sm)} />
        ) : (
          <Codicon name="mic" size="0.875rem" />
        )}
      </Button>
    </Tip>
  )
}
