import { ComposerPrimitive } from '@assistant-ui/react'
import {
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState
} from 'react'

import { pickAttachment, type StagedAttachment } from '@/app/chat/attachments'
import {
  applyCompletion,
  type CompletionEntry,
  detectTrigger,
  fetchCompletions
} from '@/app/chat/composer-completions'
import { useVoiceRecorder } from '@/app/chat/use-voice-recorder'
import { composerFill, composerSurfaceGlass } from '@/components/chat/composer-dock'
import { useI18n } from '@/i18n'
import { stopSpeaking } from '@/lib/tts'
import { IS_DESKTOP } from '@/lib/platform'
import { cn } from '@/lib/utils'
import { useStore } from '@/store/atom'
import { $busy, $sessionId, sendPrompt } from '@/store/chat'
import { $history, $queue, dequeue, enqueue, removeQueuedAt } from '@/store/composer'
import { triggerHaptic } from '@/store/haptics'
import { $subagentsBySession } from '@/store/subagents'
import { $threadScrolledUp } from '@/store/thread-scroll'
import { $autoSpeakReplies, seedAutoSpeak, setAutoSpeakReplies } from '@/store/voice-prefs'

import { AttachmentList } from './attachments'
import { COMPOSER_COMPACT_PILL_PX, COMPOSER_FADE_BACKGROUND, COMPOSER_STACK_BREAKPOINT_PX } from './composer-utils'
import { ContextMenu } from './context-menu'
import { ComposerControls } from './controls'
import { COMPOSER_DROP_FADE_CLASS } from './drop-affordance'
import { focusComposerInput, markActiveComposer } from './focus'
import { HelpHint } from './help-hint'
import { QueuePanel } from './queue-panel'
import {
  composerPlainText,
  deleteChipBeforeCaret,
  deleteSelectionInEditor,
  insertPlainTextAtCaret,
  normalizeComposerEditorDom,
  placeCaretEnd,
  renderComposerContents,
  RICH_INPUT_SLOT
} from './rich-editor'
import { ComposerStatusStack } from './status-stack'
import { CodingStatusRow } from './status-stack/coding-row'
import { ComposerTriggerPopover } from './trigger-popover'
import type { ChatBarProps, VoiceStatus } from './types'
import { UrlDialog } from './url-dialog'
import { VoiceActivity } from './voice-activity'

const FETCH_DEBOUNCE_MS = 120
const NOTICE_MS = 4000

export function ChatBar({ onSubmit, onCancel }: ChatBarProps) {
  const { t } = useI18n()
  const c = t.composer
  const busy = useStore($busy)
  const history = useStore($history)
  const queue = useStore($queue)
  const autoSpeak = useStore($autoSpeakReplies)
  const scrolledUp = useStore($threadScrolledUp)
  const sessionId = useStore($sessionId)

  // Detached content lives in the contentEditable DOM; `hasText` is the only
  // typing-driven render (it gates the send button). draftRef mirrors the live
  // serialized text so submit/keydown read it synchronously.
  const [hasText, setHasText] = useState(false)
  const [staged, setStaged] = useState<StagedAttachment[]>([])
  const [notice, setNotice] = useState('')
  const [isHelpHint, setIsHelpHint] = useState(false)

  // Trigger / completion popover state.
  const [trigger, setTrigger] = useState<{ kind: '@' | '/' } | null>(null)
  const [items, setItems] = useState<CompletionEntry[]>([])
  const [activeIndex, setActiveIndex] = useState(0)
  const [triggerLoading, setTriggerLoading] = useState(false)
  const replaceFromRef = useRef(0)

  const [histIndex, setHistIndex] = useState(-1)
  const [urlOpen, setUrlOpen] = useState(false)
  const [urlValue, setUrlValue] = useState('')
  const urlInputRef = useRef<HTMLInputElement | null>(null)
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>('idle')
  const [voiceElapsed, setVoiceElapsed] = useState(0)

  const editorRef = useRef<HTMLDivElement | null>(null)
  const composerRef = useRef<HTMLFormElement | null>(null)
  const composerSurfaceRef = useRef<HTMLDivElement | null>(null)
  const fetchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const composingRef = useRef(false)
  const voiceTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined)

  const { stacked, compactPill } = useComposerMetrics(composerRef)
  const subagents = useStore($subagentsBySession)
  const hasSubagents = (sessionId ? subagents[sessionId] : subagents.active)?.length ? true : false
  const statusStackVisible = queue.length > 0 || hasSubagents

  // Seed auto-speak pref once.
  useEffect(() => void seedAutoSpeak(), [])

  // Auto-drain the next queued prompt when the turn frees up.
  useEffect(() => {
    if (busy) return
    const queued = dequeue()
    if (queued) void sendPrompt(queued)
  }, [busy])

  // Cleanup timers.
  useEffect(
    () => () => {
      clearTimeout(fetchTimer.current)
      clearTimeout(noticeTimer.current)
      clearInterval(voiceTimer.current)
    },
    []
  )

  // ── Voice dictation ──────────────────────────────────────────────────────
  const voice = useVoiceRecorder(transcript => {
    appendToComposer(transcript)
    requestAnimationFrame(() => focusComposerInput(editorRef.current))
  })

  useEffect(() => {
    const status: VoiceStatus = voice.transcribing ? 'transcribing' : voice.recording ? 'recording' : 'idle'
    setVoiceStatus(status)
    clearInterval(voiceTimer.current)
    if (status === 'recording') {
      setVoiceElapsed(0)
      voiceTimer.current = setInterval(() => setVoiceElapsed(s => s + 1), 1000)
    }
  }, [voice.recording, voice.transcribing])

  // ── Notices (client-side slash results) ──────────────────────────────────
  const showNotice = (message: string) => {
    clearTimeout(noticeTimer.current)
    setNotice(message)
    noticeTimer.current = setTimeout(() => setNotice(''), NOTICE_MS)
  }

  // ── Editor read / write helpers ──────────────────────────────────────────
  const syncHasText = useCallback((editor: HTMLDivElement) => {
    const text = composerPlainText(editor)
    setHasText(text.trim().length > 0)
    setIsHelpHint(text === '?')
    return text
  }, [])

  const clearInput = () => {
    const editor = editorRef.current
    if (editor) editor.replaceChildren()
    setHasText(false)
    setIsHelpHint(false)
  }

  /** Append text/ref to the composer (snippets, URLs, voice transcript). Re-renders
   *  so any `@ref` becomes a chip. */
  const appendToComposer = (value: string) => {
    const editor = editorRef.current
    if (!editor) return
    const cur = composerPlainText(editor)
    const next = cur.trim() ? `${cur.replace(/\s+$/, '')} ${value} ` : `${value} `
    renderComposerContents(editor, next)
    placeCaretEnd(editor)
    setHasText(next.trim().length > 0)
    setIsHelpHint(false)
  }

  const closeTrigger = () => {
    clearTimeout(fetchTimer.current)
    setTrigger(null)
    setItems([])
    setTriggerLoading(false)
  }

  const refreshTrigger = useCallback(() => {
    const editor = editorRef.current
    if (!editor) return
    const text = composerPlainText(editor)
    const cursor = text.length
    const trig = detectTrigger(text, cursor)
    if (!trig) {
      closeTrigger()
      return
    }
    setTrigger({ kind: trig.kind === 'slash' ? '/' : '@' })
    setTriggerLoading(true)
    clearTimeout(fetchTimer.current)
    fetchTimer.current = setTimeout(() => {
      void fetchCompletions(trig).then(res => {
        setItems(res.items)
        replaceFromRef.current = res.replaceFrom
        setActiveIndex(0)
        setTriggerLoading(false)
      })
    }, FETCH_DEBOUNCE_MS)
  }, [])

  const pick = (entry: CompletionEntry) => {
    const editor = editorRef.current
    if (!editor) return
    const text = composerPlainText(editor)
    const applied = applyCompletion(text, text.length, replaceFromRef.current, entry)
    renderComposerContents(editor, applied.text)
    placeCaretEnd(editor)
    setHasText(applied.text.trim().length > 0)
    closeTrigger()
    focusComposerInput(editor)
  }

  // ── Submit ───────────────────────────────────────────────────────────────
  const submit = () => {
    const editor = editorRef.current
    const raw = editor ? composerPlainText(editor) : ''
    const value = raw.trim()
    if (!value && staged.length === 0) return

    // Attachment refs (@file:/@image:) are spliced into the prompt text.
    const full = [...staged.map(a => a.ref), value].filter(Boolean).join(' ')
    void triggerHaptic('submit')
    const result = onSubmit(full)
    clearInput()
    setStaged([])
    setHistIndex(-1)
    closeTrigger()
    if (typeof result === 'string' && result) showNotice(result)
  }

  // ── Attachments ──────────────────────────────────────────────────────────
  const attach = () => {
    void pickAttachment()
      .then(a => {
        if (a) setStaged(prev => [...prev, a])
      })
      .catch(() => {
        /* picker cancelled / unavailable */
      })
  }

  // ── URL dialog ───────────────────────────────────────────────────────────
  const openUrlDialog = () => {
    setUrlValue('')
    setUrlOpen(true)
    requestAnimationFrame(() => urlInputRef.current?.focus())
  }
  const submitUrl = () => {
    const url = urlValue.trim()
    if (!url) return
    appendToComposer(`@url:\`${url}\``)
    setUrlOpen(false)
    focusComposerInput(editorRef.current)
  }

  // ── DOM event handlers ───────────────────────────────────────────────────
  const handleEditorInput = (event: FormEvent<HTMLDivElement>) => {
    if (composingRef.current) return
    const editor = event.currentTarget
    normalizeComposerEditorDom(editor)
    syncHasText(editor)
    setHistIndex(-1)
    window.setTimeout(refreshTrigger, 0)
  }

  const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
    // Image-blob paste is deferred (needs @/lib/embedded-images) — FIXME(chat-port).
    const pastedText = event.clipboardData.getData('text').trim()
    if (!pastedText) return
    event.preventDefault()
    insertPlainTextAtCaret(event.currentTarget, pastedText)
    normalizeComposerEditorDom(event.currentTarget)
    syncHasText(event.currentTarget)
    window.setTimeout(refreshTrigger, 0)
  }

  const handleEditorKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (composingRef.current || event.nativeEvent.isComposing) return

    // Backspace right after a directive chip: remove chip + its trailing space.
    if (
      event.key === 'Backspace' &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      deleteChipBeforeCaret(event.currentTarget)
    ) {
      event.preventDefault()
      syncHasText(event.currentTarget)
      return
    }

    // Non-collapsed Backspace/Delete: manual delete (native selection-delete is
    // ~O(n²) on large drafts).
    if ((event.key === 'Backspace' || event.key === 'Delete') && deleteSelectionInEditor(event.currentTarget)) {
      event.preventDefault()
      syncHasText(event.currentTarget)
      return
    }

    // Cmd/Ctrl+Shift+K drains the next queued message.
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.shiftKey && event.key.toLowerCase() === 'k') {
      event.preventDefault()
      if (!busy) {
        const next = removeQueuedAt(0)
        if (next) void sendPrompt(next)
      }
      return
    }

    // Trigger popover navigation.
    if (trigger && items.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setActiveIndex(idx => (idx + 1) % items.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setActiveIndex(idx => (idx - 1 + items.length) % items.length)
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        const item = items[activeIndex]
        if (item) pick(item)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        closeTrigger()
        return
      }
    }

    // History: ArrowUp/Down when the caret is at the very start with no drawer.
    const selection = window.getSelection()
    const atStart =
      !trigger &&
      selection?.isCollapsed &&
      selection.anchorOffset === 0 &&
      (selection.anchorNode === event.currentTarget || selection.anchorNode === event.currentTarget.firstChild)
    if (event.key === 'ArrowUp' && atStart && history.length > 0) {
      event.preventDefault()
      const i = Math.min(histIndex + 1, history.length - 1)
      setHistIndex(i)
      renderComposerContents(event.currentTarget, history[i])
      placeCaretEnd(event.currentTarget)
      setHasText(true)
      return
    }
    if (event.key === 'ArrowDown' && histIndex >= 0) {
      event.preventDefault()
      const i = histIndex - 1
      setHistIndex(i)
      const text = i < 0 ? '' : history[i]
      renderComposerContents(event.currentTarget, text)
      placeCaretEnd(event.currentTarget)
      setHasText(text.trim().length > 0)
      return
    }

    // Cmd/Ctrl+Enter = send everywhere (the mobile-safe submit; soft-keyboard
    // Return stays a newline). Steer mid-turn is backend-blocked — while busy
    // this queues via onSubmit. FLAG(chat-port).
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.shiftKey) {
      event.preventDefault()
      submit()
      return
    }

    // Plain Enter sends on DESKTOP only; on mobile it inserts a newline so the
    // soft keyboard's Return never fires a message mid-compose.
    if (event.key === 'Enter' && !event.shiftKey && IS_DESKTOP) {
      event.preventDefault()
      submit()
      return
    }

    if (event.key === 'Escape') {
      if (trigger) {
        event.preventDefault()
        closeTrigger()
        return
      }
      if (busy && onCancel) {
        event.preventDefault()
        void triggerHaptic('warning')
        onCancel()
      }
    }
  }

  const hasComposerPayload = hasText || staged.length > 0
  const canSubmit = busy || hasComposerPayload
  const busyAction: 'queue' | 'stop' = busy && hasComposerPayload ? 'queue' : 'stop'
  const placeholder = busy ? c.placeholderFollowUp : c.message

  const voiceActivityState = { elapsedSeconds: voiceElapsed, level: 0, status: voiceStatus }

  return (
    <>
      <ComposerPrimitive.Root
        className={cn(
          'group/composer z-30 overflow-visible rounded-2xl',
          'absolute bottom-0 left-1/2 w-[min(var(--composer-width),calc(100%-2rem))] max-w-full -translate-x-1/2 pt-2 pb-[var(--composer-shell-pad-block-end)]'
        )}
        data-slot="composer-root"
        data-status-stack={statusStackVisible ? '' : undefined}
        data-thread-scrolled-up={scrolledUp ? '' : undefined}
        onSubmit={e => {
          e.preventDefault()
          if (composingRef.current) return
          submit()
        }}
        ref={composerRef}
      >
        {isHelpHint && <HelpHint />}
        {trigger && (
          <ComposerTriggerPopover
            activeIndex={activeIndex}
            items={items}
            kind={trigger.kind}
            loading={triggerLoading}
            onHover={setActiveIndex}
            onPick={pick}
          />
        )}
        {/* Session-scoped status stack (subagents + queue). Out of flow so it
            never inflates the composer's measured height; overlays the chat. */}
        <ComposerStatusStack
          queue={
            queue.length > 0 ? (
              <QueuePanel
                busy={busy}
                entries={queue}
                onDelete={index => removeQueuedAt(index)}
                onSendNow={index => {
                  const text = removeQueuedAt(index)
                  if (text && !busy) void sendPrompt(text)
                  else if (text) enqueue(text)
                }}
              />
            ) : null
          }
          sessionId={sessionId}
        />
        <div
          className="pointer-events-none absolute inset-0 rounded-[inherit]"
          style={{ background: COMPOSER_FADE_BACKGROUND }}
        />
        <div className="relative w-full rounded-[inherit]">
          <div
            className={cn(
              'group/composer-surface relative z-4 isolate grid grid-rows-[auto_1fr] overflow-hidden rounded-[inherit] border border-[color-mix(in_srgb,var(--dt-composer-ring)_calc(18%*var(--composer-ring-strength)),var(--dt-input))]',
              COMPOSER_DROP_FADE_CLASS
            )}
            data-slot="composer-surface"
            ref={composerSurfaceRef}
          >
            <div
              aria-hidden
              className={cn(
                'pointer-events-none absolute inset-0 -z-10 rounded-[inherit]',
                composerFill,
                composerSurfaceGlass
              )}
            />
            <CodingStatusRow />
            <div
              className={cn(
                'relative z-1 flex min-h-0 w-full flex-col gap-(--composer-row-gap) overflow-hidden rounded-[inherit] px-(--composer-surface-pad-x) py-(--composer-surface-pad-y) transition-opacity duration-200 ease-out',
                scrolledUp
                  ? 'opacity-30 group-hover/composer:opacity-100 group-focus-within/composer-surface:opacity-100'
                  : 'opacity-100'
              )}
              data-slot="composer-fade"
            >
              {notice && (
                <div className="whitespace-pre-wrap break-words rounded-lg border border-border/55 bg-muted/45 px-2.5 py-1.5 font-mono text-[0.7rem] leading-4 text-muted-foreground">
                  {notice}
                </div>
              )}
              <VoiceActivity state={voiceActivityState} />
              {staged.length > 0 && (
                <AttachmentList
                  attachments={staged}
                  onRemove={index => setStaged(prev => prev.filter((_, j) => j !== index))}
                />
              )}
              <div
                className={cn(
                  'grid w-full',
                  stacked
                    ? 'grid-cols-[auto_1fr] gap-(--composer-row-gap) [grid-template-areas:"input_input"_"menu_controls"]'
                    : 'grid-cols-[auto_1fr_auto] items-center gap-(--composer-control-gap) [grid-template-areas:"menu_input_controls"]'
                )}
              >
                <div className="flex translate-y-[3px] items-start gap-(--composer-control-gap) self-start [grid-area:menu]">
                  <ContextMenu
                    onInsertText={appendToComposer}
                    onOpenUrlDialog={openUrlDialog}
                    onPickAttachment={attach}
                  />
                </div>
                <div className="min-w-0 [grid-area:input]">
                  <div className={cn('relative', stacked ? 'w-full' : 'min-w-(--composer-input-inline-min-width) flex-1')}>
                    <div
                      aria-label={c.message}
                      autoCapitalize="off"
                      autoCorrect="off"
                      className={cn(
                        'min-h-(--composer-input-min-height) max-h-(--composer-input-max-height) cursor-text overflow-y-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere] bg-transparent pb-1 pr-1 pt-1 leading-normal text-foreground outline-none',
                        'empty:before:content-[attr(data-placeholder)] empty:before:text-muted-foreground/60',
                        '**:data-ref-text:cursor-default',
                        stacked && 'pl-3',
                        stacked ? 'w-full' : 'min-w-(--composer-input-inline-min-width) flex-1'
                      )}
                      contentEditable
                      data-placeholder={placeholder}
                      data-slot={RICH_INPUT_SLOT}
                      onBlur={() => window.setTimeout(closeTrigger, 80)}
                      onCompositionEnd={event => {
                        composingRef.current = false
                        normalizeComposerEditorDom(event.currentTarget)
                        syncHasText(event.currentTarget)
                        window.setTimeout(refreshTrigger, 0)
                      }}
                      onCompositionStart={() => {
                        composingRef.current = true
                      }}
                      onFocus={() => markActiveComposer('main')}
                      onInput={handleEditorInput}
                      onKeyDown={handleEditorKeyDown}
                      onMouseUp={refreshTrigger}
                      onPaste={handlePaste}
                      ref={editorRef}
                      role="textbox"
                      spellCheck={false}
                      suppressContentEditableWarning
                    />
                    {/* assistant-ui needs ComposerPrimitive.Input in the tree so the
                        composer-state binding wires up; the real UI is our
                        contentEditable above, so the primitive is invisible.
                        `asChild` swaps its TextareaAutosize for a plain textarea. */}
                    <ComposerPrimitive.Input
                      asChild
                      submitMode="ctrlEnter"
                      tabIndex={-1}
                      unstable_focusOnScrollToBottom={false}
                    >
                      <textarea
                        aria-hidden
                        autoCapitalize="off"
                        autoComplete="off"
                        autoCorrect="off"
                        className="sr-only"
                        spellCheck={false}
                        tabIndex={-1}
                      />
                    </ComposerPrimitive.Input>
                  </div>
                </div>
                <div className="flex items-center justify-end gap-(--composer-control-gap) [grid-area:controls]">
                  <ComposerControls
                    autoSpeak={autoSpeak}
                    busy={busy}
                    busyAction={busyAction}
                    canSubmit={canSubmit}
                    compactModelPill={compactPill}
                    dictationActive={voiceStatus !== 'idle'}
                    dictationEnabled={!voice.transcribing}
                    dictationStatus={voiceStatus}
                    disabled={false}
                    onDictate={voice.toggle}
                    onToggleAutoSpeak={() => {
                      const next = !autoSpeak
                      void setAutoSpeakReplies(next).catch(() => {})
                      if (!next) stopSpeaking()
                    }}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      </ComposerPrimitive.Root>

      <UrlDialog
        inputRef={urlInputRef}
        onChange={setUrlValue}
        onOpenChange={setUrlOpen}
        onSubmit={submitUrl}
        open={urlOpen}
        value={urlValue}
      />
    </>
  )
}

/**
 * Inline metrics — collapse the row to a stacked layout when the composer gets
 * narrow, and shed the model-pill label a step before that. Trimmed from the
 * desktop use-composer-metrics hook (popout metrics dropped).
 */
function useComposerMetrics(composerRef: React.RefObject<HTMLElement | null>) {
  const [stacked, setStacked] = useState(false)
  const [compactPill, setCompactPill] = useState(false)

  useEffect(() => {
    const el = composerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const measure = () => {
      const width = el.getBoundingClientRect().width
      setStacked(width > 0 && width < COMPOSER_STACK_BREAKPOINT_PX)
      setCompactPill(width > 0 && width < COMPOSER_COMPACT_PILL_PX)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    measure()
    return () => observer.disconnect()
  }, [composerRef])

  return { stacked, compactPill }
}
