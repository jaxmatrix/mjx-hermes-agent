import { useStore } from '@nanostores/react'
import { useState } from 'react'

import type { MenuKit } from '@/components/ui/actions-menu'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  dropdownMenuRow,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { MenuDrawer } from '@/components/ui/menu-drawer'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { triggerHaptic } from '@/lib/haptics'
import { AudioLines, Ear, EarOff, iconSize, Loader2, Square, Volume2, VolumeX } from '@/lib/icons'
import { IS_MOBILE } from '@/lib/platform'
import { cn } from '@/lib/utils'
import { $wakeWord, toggleWakeWord } from '@/store/wake-word'

import { ACTIVE_ICON_BTN, GHOST_ICON_BTN } from './control-classes'
import type { ChatBarState, VoiceStatus } from './types'
import { VoiceEngineRows } from './voice-engine-rows'

export interface VoiceMenuProps {
  autoSpeak: boolean
  disabled: boolean
  state: ChatBarState
  voiceStatus: VoiceStatus
  onDictate: () => void
  onStartConversation: () => void
  onToggleAutoSpeak: () => void
}

/**
 * Every voice control behind one trigger: dictation, spoken replies, the
 * "hey hermes" wake word, and starting a full conversation.
 *
 * On mobile opens a bottom `MenuDrawer` instead of a floating dropdown.
 */
export function VoiceMenu({
  autoSpeak,
  disabled,
  state,
  voiceStatus,
  onDictate,
  onStartConversation,
  onToggleAutoSpeak
}: VoiceMenuProps) {
  const { t } = useI18n()
  const c = t.composer
  const wake = useStore($wakeWord)
  const [drawerOpen, setDrawerOpen] = useState(false)

  const phrase = wake.phrase || 'hey hermes'
  const dictating = state.voice.active || voiceStatus !== 'idle'
  const wakeListening = wake.listening
  // Anything live keeps the trigger lit, so a folded menu can never look idle
  // while the mic is open.
  const active = dictating || wakeListening || autoSpeak

  const dictationLabel =
    voiceStatus === 'recording'
      ? c.stopDictation
      : voiceStatus === 'transcribing'
        ? c.transcribingDictation
        : c.voiceDictation

  const wakeLabel = wakeListening ? c.wakeWordListening(phrase) : c.wakeWordOff(phrase)
  const triggerLabel = dictating ? dictationLabel : wakeListening ? wakeLabel : c.voiceControls

  const trigger = (
    <Button
      aria-label={triggerLabel}
      className={cn(GHOST_ICON_BTN, 'p-0', active && ACTIVE_ICON_BTN)}
      disabled={disabled}
      onClick={IS_MOBILE ? () => setDrawerOpen(true) : undefined}
      size="icon"
      type="button"
      variant="ghost"
    >
      {voiceStatus === 'recording' ? (
        <Square className={cn('fill-current', iconSize.xs)} />
      ) : voiceStatus === 'transcribing' ? (
        <Loader2 className={cn('animate-spin', iconSize.sm)} />
      ) : wakeListening ? (
        <Ear className={iconSize.sm} />
      ) : (
        <Codicon name="mic" size="0.875rem" />
      )}
    </Button>
  )

  const tip = (
    <Tip label={wake.notice && !dictating ? `${triggerLabel} — ${wake.notice}` : triggerLabel} placement="control">
      {trigger}
    </Tip>
  )

  if (IS_MOBILE) {
    const renderItems = (kit: MenuKit) => (
      <>
        <kit.Item
          disabled={disabled}
          onSelect={() => {
            triggerHaptic('open')
            onStartConversation()
          }}
        >
          <AudioLines className={iconSize.sm} />
          <span>{c.startVoice}</span>
        </kit.Item>
        <kit.Separator />
        <kit.Item
          disabled={disabled || !state.voice.enabled || voiceStatus === 'transcribing'}
          onSelect={event => {
            event.preventDefault()
            triggerHaptic(dictating ? 'close' : 'open')
            onDictate()
          }}
        >
          <Codicon name="mic" size="0.875rem" />
          <span>{dictationLabel}</span>
          {dictating ? <Codicon className="ms-auto opacity-70" name="check" size="0.875rem" /> : null}
        </kit.Item>
        <kit.Item
          disabled={disabled}
          onSelect={event => {
            event.preventDefault()
            triggerHaptic(autoSpeak ? 'close' : 'open')
            onToggleAutoSpeak()
          }}
        >
          {autoSpeak ? <Volume2 className={iconSize.sm} /> : <VolumeX className={iconSize.sm} />}
          <span>{autoSpeak ? c.stopSpeakingReplies : c.speakReplies}</span>
          {autoSpeak ? <Codicon className="ms-auto opacity-70" name="check" size="0.875rem" /> : null}
        </kit.Item>
        <kit.Item
          disabled={disabled || wake.pending}
          onSelect={event => {
            event.preventDefault()
            triggerHaptic(wakeListening ? 'close' : 'open')
            void toggleWakeWord()
          }}
        >
          {wakeListening ? <Ear className={iconSize.sm} /> : <EarOff className={iconSize.sm} />}
          <span>{wakeLabel}</span>
          {wakeListening ? <Codicon className="ms-auto opacity-70" name="check" size="0.875rem" /> : null}
        </kit.Item>
      </>
    )

    return (
      <>
        {tip}
        <MenuDrawer onOpenChange={setDrawerOpen} open={drawerOpen} render={renderItems} title={c.voiceControls} />
      </>
    )
  }

  return (
    <DropdownMenu>
      <Tip label={wake.notice && !dictating ? `${triggerLabel} — ${wake.notice}` : triggerLabel} placement="control">
        <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent align="end" className="min-w-52">
        <DropdownMenuItem
          className={dropdownMenuRow}
          disabled={disabled}
          onSelect={() => {
            triggerHaptic('open')
            onStartConversation()
          }}
        >
          <AudioLines className={iconSize.sm} />
          {c.startVoice}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <VoiceEngineRows disabled={disabled} />
        <DropdownMenuSeparator />
        {/* Checkbox items, because all three are toggles the user is reading
            the CURRENT state of — the reason they were pressed-state buttons
            before. A plain row would fold that state away with the menu. */}
        <DropdownMenuCheckboxItem
          checked={dictating}
          className={dropdownMenuRow}
          disabled={disabled || !state.voice.enabled || voiceStatus === 'transcribing'}
          onSelect={event => {
            // Keep the menu open: dictation is a mode you watch, and closing
            // on select hides the recording state the trigger just entered.
            event.preventDefault()
            triggerHaptic(dictating ? 'close' : 'open')
            onDictate()
          }}
        >
          {dictationLabel}
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={autoSpeak}
          className={dropdownMenuRow}
          disabled={disabled}
          onSelect={event => {
            event.preventDefault()
            triggerHaptic(autoSpeak ? 'close' : 'open')
            onToggleAutoSpeak()
          }}
        >
          {autoSpeak ? <Volume2 className={iconSize.sm} /> : <VolumeX className={iconSize.sm} />}
          {autoSpeak ? c.stopSpeakingReplies : c.speakReplies}
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={wakeListening}
          className={dropdownMenuRow}
          disabled={disabled || wake.pending}
          onSelect={event => {
            event.preventDefault()
            triggerHaptic(wakeListening ? 'close' : 'open')
            void toggleWakeWord()
          }}
        >
          {wakeListening ? <Ear className={iconSize.sm} /> : <EarOff className={iconSize.sm} />}
          {wakeLabel}
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
