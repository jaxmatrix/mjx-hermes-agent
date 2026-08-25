'use client'

import { type ToolCallMessagePartProps, useAuiState } from '@assistant-ui/react'
import { useStore } from '@nanostores/react'
import {
  type ComponentProps,
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'

import { requestComposerFocus, requestComposerInsert } from '@/app/chat/composer/focus'
import { useSessionView } from '@/app/chat/session-view'
import { ToolFallback } from '@/components/assistant-ui/tool/fallback'
import { WIDGET_SHELL_CLASS } from '@/components/chat/widget-shell'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { Textarea } from '@/components/ui/textarea'
import { Tip } from '@/components/ui/tooltip'
import { gatewayRpcErrorCode } from '@/gateway/rpc-error'
import { useI18n } from '@/i18n'
import { triggerHaptic } from '@/lib/haptics'
import { CircleLetterA, Loader2, MessageQuestion } from '@/lib/icons'
import { keyOwningClarifyCard } from '@/lib/keybinds/composer-focus-keys'
import { cn } from '@/lib/utils'
import { CLARIFY_UNKNOWN_QUESTION_CODE, respondClarify, respondClarifyBatch } from '@/store/chat'
import {
  bareChoice,
  type ClarifyQuestion,
  matchClarifyRequest,
  normalizeChoices,
  normalizeQuestions,
  readChoices,
  RECOMMENDED_LABEL
} from '@/store/clarify'
import { notify, notifyError } from '@/store/notifications'
import { sessionClarifyRequest } from '@/store/prompts'

import { selectMessageRunning } from './tool/fallback-model'
import { parseMaybeObject } from './tool/fallback-model/format'

// Ported from apps/desktop/src/components/assistant-ui/clarify-tool.tsx.
//
// This inline panel is the ONLY interactive clarify surface (same as desktop —
// there is no footer bar). Question and choices come from the `clarify.request`
// gateway event parked in `$clarify`, because `tool.start` carries no args; the
// tool args are only a fallback (they land with `tool.complete`). The request is
// read per SESSION KEY, so a tile's clarify answers the tile's agent — and so it
// survives the runtime-id rotation a cold resume performs (store/prompts.ts).

interface ClarifyArgs {
  question?: string
  choices?: string[] | null
  multiSelect?: boolean
  /** Batch clarify: present INSTEAD of question/choices. */
  questions?: ClarifyQuestion[]
}

interface ClarifyResult {
  question?: string
  answer?: string
  error?: string
}

/** One settled row of a batch result (`_batch_result` in tools/clarify_tool.py). */
interface ClarifyBatchResponse {
  question: string
  answer: string
}

function stringField(row: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = row[key]

    if (typeof value === 'string') {
      return value
    }
  }
}

function readClarifyArgs(args: unknown): ClarifyArgs {
  const row = parseMaybeObject(args)
  const question = stringField(row, 'question')
  const questions = normalizeQuestions(row.questions)

  // The same hygiene the gateway path gets (store/clarify.ts): choices come
  // from a model's tool call, so a blank / multi-line / over-long entry is a
  // rendering bug waiting to happen rather than an option worth offering.
  return {
    question,
    choices: readChoices('tool_args', question ?? '', row.choices),
    multiSelect: row.multi_select === true,
    ...(questions.length > 0 ? { questions } : {})
  }
}

/**
 * Parse a BATCH clarify's tool JSON: `{responses: [{question, user_response}]}`
 * (`_batch_result`). Nothing here shares a key with the single-question result,
 * so the settled card has to know which one it is holding before it reads it —
 * `readClarifyResult` on a batch result returns an empty answer and renders a
 * card with the questions silently missing.
 */
export function readClarifyBatchResult(result: unknown): ClarifyBatchResponse[] {
  const rows = parseMaybeObject(result).responses

  if (!Array.isArray(rows)) {
    return []
  }

  return rows.flatMap(row => {
    const entry = parseMaybeObject(row)
    const question = stringField(entry, 'question')

    return question ? [{ question, answer: stringField(entry, 'user_response', 'answer') ?? '' }] : []
  })
}

/** Parse clarify tool JSON (`question` + `user_response`). */
export function readClarifyResult(result: unknown): ClarifyResult {
  const row = parseMaybeObject(result)

  if (Object.keys(row).length === 0) {
    return typeof result === 'string' && result.trim() ? { answer: result.trim() } : {}
  }

  return {
    question: stringField(row, 'question'),
    answer: stringField(row, 'user_response', 'answer'),
    error: stringField(row, 'error')
  }
}

const letterFor = (index: number): string => String.fromCharCode(65 + index)

const OPTION_ROW_CLASS =
  'flex w-full items-start gap-2 rounded-[0.25rem] px-1.5 py-1 text-start disabled:cursor-not-allowed disabled:opacity-50'

// field-sizing on top of Textarea's shared chrome; kill min-h-16 for one-liners.
const CLARIFY_TEXTAREA_CLASS = 'field-sizing-content max-h-40 min-h-0 resize-none'

const CLARIFY_SHELL_CLASS = `${WIDGET_SHELL_CLASS} text-[length:var(--conversation-text-font-size)] text-(--ui-text-primary)`

const CLARIFY_ICON_CLASS = 'mt-px size-4 shrink-0 text-(--ui-text-tertiary)'

function ClarifyShell({ children, className, ...props }: ComponentProps<'div'>) {
  return (
    <div className={cn(CLARIFY_SHELL_CLASS, className)} data-slot="clarify-inline" {...props}>
      {children}
    </div>
  )
}

function ClarifyLine({
  children,
  className,
  icon: Icon,
  ...props
}: ComponentProps<'div'> & { icon: typeof MessageQuestion }) {
  return (
    <div className={cn('flex items-start gap-2', className)} {...props}>
      <div className="min-w-0 flex-1">{children}</div>
      <Icon aria-hidden className={CLARIFY_ICON_CLASS} />
    </div>
  )
}

function KeyBadge({ char, preview, selected }: { char: string; preview?: boolean; selected: boolean }) {
  return (
    <Kbd
      className={cn(
        'mt-px',
        selected && 'border-primary bg-primary text-white shadow-none',
        !selected && preview && 'border-primary text-primary shadow-none'
      )}
      size="sm"
    >
      {char}
    </Kbd>
  )
}

/**
 * A choice, with the agent's recommendation set apart from the option itself.
 *
 * The backend has no `recommended` field: `mark_recommended` appends
 * "(Recommended)" to the FIRST choice string, and `strip_recommended` takes it
 * back off the answer, so the label is presentation that arrives inside the
 * data. Rendering it as part of the option text made it read like part of the
 * answer; the answer still goes back verbatim (the tool strips it).
 */
function ChoiceLabel({ choice }: { choice: string }) {
  const bare = bareChoice(choice)

  if (bare === choice) {
    return <>{choice}</>
  }

  return (
    <>
      {bare} <span className="text-(--ui-text-tertiary)">{RECOMMENDED_LABEL}</span>
    </>
  )
}

/**
 * One choice row.
 *
 * `Tip` is this repo's themed stand-in for a native `title=` (banned on a
 * button by the no-native-title guard). It renders the child untouched when
 * `label` is falsy, so the live card is unaffected and only the settled
 * skipped card picks up the hover hint.
 *
 * `active` is the KEYBOARD cursor — where arrow keys have moved to — which is
 * a different thing from `selected`, the answer staged for submit. The settled
 * card passes neither, so its rows stay plain.
 */
function ChoiceButton({
  active = false,
  char,
  choice,
  disabled,
  keyShortcuts,
  onClick,
  selected = false,
  title
}: {
  active?: boolean
  char: string
  choice: string
  disabled?: boolean
  keyShortcuts?: string
  onClick: () => void
  selected?: boolean
  title?: string
}) {
  return (
    <Tip label={title}>
      <button
        aria-current={active || undefined}
        aria-keyshortcuts={keyShortcuts}
        className={cn(
          OPTION_ROW_CLASS,
          'text-(--ui-text-secondary) hover:bg-(--chrome-action-hover) hover:text-(--ui-text-primary)',
          active && 'bg-(--chrome-action-hover) text-(--ui-text-primary)',
          selected && 'text-(--ui-text-primary)'
        )}
        data-choice
        data-highlighted={active || undefined}
        disabled={disabled}
        onClick={onClick}
        type="button"
      >
        <KeyBadge char={char} preview={active} selected={selected} />
        <span className="flex-1 wrap-anywhere">
          <ChoiceLabel choice={choice} />
        </span>
      </button>
    </Tip>
  )
}

export const ClarifyTool = (props: ToolCallMessagePartProps) => {
  // Answered → settled Q&A (ToolFallback collapsed the answer away).
  if (props.result !== undefined) {
    return <ClarifyToolSettled {...props} />
  }

  return <ClarifyToolLive {...props} />
}

function ClarifyToolLive(props: ToolCallMessagePartProps) {
  const messageRunning = useAuiState(selectMessageRunning)
  const sessionKey = useStore(useSessionView().$runtimeId) ?? ''
  const request = useStore(sessionClarifyRequest(sessionKey))
  const rowQuestion = useMemo(() => readClarifyArgs(props.args).question ?? '', [props.args])

  // Stopped mid-prompt with no result — don't leave a dead interactive panel.
  //
  // But "running" is NOT what makes a clarify answerable, and gating on it alone
  // is what kept the synthetic row from paying off on the very paths it exists
  // for. `selectMessageRunning` is `slice.busy && row.pending`, and `busy` is
  // set by `message.start` — an event that has ALREADY gone by whenever the row
  // had to be synthesized (a background session whose slice this event created,
  // a mid-turn reattach, a resume). The agent is parked in `_block` regardless,
  // so the pending request in the prompt store is the honest test: it is written
  // by `clarify.request`, and cleared on answer, `message.complete` and `error`.
  if (!messageRunning && !matchClarifyRequest(request, rowQuestion)) {
    return <ToolFallback {...props} />
  }

  return <ClarifyToolPending {...props} />
}

/**
 * The settled BATCH card: every question the agent asked, with what it got.
 *
 * A blank answer is not "no answer given" — `_batch_result` writes an empty
 * `user_response` for a question the user skipped AND for one a timeout never
 * reached, and both mean the agent proceeded without it. Saying "Skipped" for
 * a blank is the only honest reading the client has, and it is the same word
 * the single-question card uses for the same absence.
 */
function ClarifyToolBatchSettled({ result }: ToolCallMessagePartProps) {
  const { t } = useI18n()
  const copy = t.assistant.clarify
  const responses = useMemo(() => readClarifyBatchResult(result), [result])

  return (
    <ClarifyShell className="my-1.5 grid gap-2.5" data-clarify-settled="">
      {responses.map((row, index) => {
        const blank = !row.answer.trim()

        return (
          <div className="grid gap-1.5" key={`${index}-${row.question}`}>
            <ClarifyLine icon={MessageQuestion}>
              <span className="whitespace-pre-wrap font-medium leading-(--conversation-line-height)">
                {row.question}
              </span>
            </ClarifyLine>
            <ClarifyLine icon={CircleLetterA}>
              <p
                className={cn(
                  'whitespace-pre-wrap leading-(--conversation-line-height)',
                  blank ? 'italic text-(--ui-text-tertiary)' : 'text-(--ui-text-secondary)'
                )}
                data-clarify-answer=""
              >
                {blank ? copy.skipped : row.answer}
              </p>
            </ClarifyLine>
          </div>
        )
      })}
    </ClarifyShell>
  )
}

function ClarifyToolSettled(props: ToolCallMessagePartProps) {
  // A batch result shares no key with a single one (`responses[]` vs
  // `question`/`user_response`), so reading it with the single parser yields a
  // card with no question and no answer at all.
  if (readClarifyBatchResult(props.result).length > 0) {
    return <ClarifyToolBatchSettled {...props} />
  }

  return <ClarifyToolSingleSettled {...props} />
}

function ClarifyToolSingleSettled({ args, result }: ToolCallMessagePartProps) {
  const { t } = useI18n()
  const copy = t.assistant.clarify
  const fromArgs = useMemo(() => readClarifyArgs(args), [args])
  const fromResult = useMemo(() => readClarifyResult(result), [result])

  const question = fromResult.question || fromArgs.question || ''
  const answer = fromResult.answer
  const error = fromResult.error
  const skipped = !error && answer !== undefined && !answer.trim()
  const answerText = error || (skipped ? copy.skipped : (answer ?? '').trim())
  const choices = fromArgs.choices ?? []

  // A SKIPPED clarify keeps its choices on screen and actionable. The blocking
  // request is long gone — the tool already returned empty — so a pick cannot
  // resolve it retroactively; instead it drafts a quoted follow-up into the
  // composer, which sends on Enter (or queues, if the agent is mid-turn).
  // Without this the card collapsed to a bare "Skipped" and the options the
  // agent offered were unrecoverable.
  const followUp = useCallback(
    (choice: string) => {
      requestComposerInsert(copy.lateAnswer(question, choice), { mode: 'block' })
      requestComposerFocus()
      void triggerHaptic('selection')
    },
    [copy, question]
  )

  return (
    <ClarifyShell className="my-1.5 grid gap-1.5" data-clarify-settled="">
      {question ? (
        <ClarifyLine icon={MessageQuestion}>
          <span className="whitespace-pre-wrap font-medium leading-(--conversation-line-height)">{question}</span>
        </ClarifyLine>
      ) : null}
      {answerText ? (
        <ClarifyLine icon={CircleLetterA}>
          <p
            className={cn(
              'whitespace-pre-wrap leading-(--conversation-line-height)',
              error ? 'text-destructive' : 'text-(--ui-text-secondary)',
              skipped && 'italic text-(--ui-text-tertiary)'
            )}
            data-clarify-answer=""
          >
            {answerText}
          </p>
        </ClarifyLine>
      ) : null}
      {skipped && choices.length > 0 ? (
        <div className="grid gap-px" data-clarify-late-choices="" role="group">
          {choices.map((choice, index) => (
            <ChoiceButton
              char={letterFor(index)}
              choice={choice}
              key={`${index}-${choice}`}
              onClick={() => followUp(choice)}
              title={copy.lateAnswerTip}
            />
          ))}
          <p className="px-1.5 pt-0.5 text-[0.6875rem] leading-4 text-(--ui-text-tertiary)">{copy.lateAnswerHint}</p>
        </div>
      ) : null}
    </ClarifyShell>
  )
}

function ClarifyToolPending(props: ToolCallMessagePartProps) {
  const sessionKey = useStore(useSessionView().$runtimeId) ?? ''
  const request = useStore(sessionClarifyRequest(sessionKey))
  const fromArgs = useMemo(() => readClarifyArgs(props.args), [props.args])
  const questions = request?.questions ?? fromArgs.questions

  if (questions && questions.length > 0) {
    return <ClarifyToolBatchPending {...props} />
  }

  return <ClarifyToolSinglePending {...props} />
}

function ClarifyToolSinglePending({ args }: ToolCallMessagePartProps) {
  const { t } = useI18n()
  const copy = t.assistant.clarify
  // The clarify panel renders INSIDE a transcript, so it belongs to the session
  // that transcript is showing — not to whichever chat is on screen. Reading the
  // view's key means a tile's clarify answers the tile's agent.
  const sessionKey = useStore(useSessionView().$runtimeId) ?? ''
  const request = useStore(sessionClarifyRequest(sessionKey))
  const fromArgs = useMemo(() => readClarifyArgs(args), [args])

  // The same tie-break the live/dead gate above uses, from one definition: the
  // two must never disagree about whether this row owns the pending request.
  const matchingRequest = useMemo(
    () => matchClarifyRequest(request, fromArgs.question ?? ''),
    [fromArgs.question, request]
  )

  // The store leads: `tool.start` ships no args, so `clarify.request` is the only
  // source for the question + choices until the tool completes.
  const question = matchingRequest?.question || fromArgs.question || ''

  // Normalized once more at the render boundary: the store holds whatever the
  // gateway sent, and a panel that renders a blank or multi-line option has no
  // way back once it is on screen (store/clarify.ts).
  const choices = useMemo(
    () => normalizeChoices(matchingRequest?.choices ?? fromArgs.choices ?? []),
    [fromArgs.choices, matchingRequest?.choices]
  )

  const hasChoices = choices.length > 0
  // `multi_select` is a pass-through hint the gateway only sends when true
  // (`_clarify_block`): the tool parses a JSON array back
  // (`_parse_multi_select_response`), so more than one pick is a real answer.
  // Ignoring it — as this card did — let a question that offered several
  // options accept exactly one, silently.
  const multiSelect = (matchingRequest?.multiSelect ?? fromArgs.multiSelect) === true && hasChoices

  const [draft, setDraft] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [selectedChoices, setSelectedChoices] = useState<string[]>([])
  // The keyboard cursor. Indices 0..choices.length-1 are the options; the
  // trailing index (=== choices.length) is the "Other" free-text row. Distinct
  // from `selectedChoice`: moving is not picking.
  const [activeIndex, setActiveIndex] = useState(0)
  const [otherFocused, setOtherFocused] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const shellRef = useRef<HTMLFormElement | null>(null)

  // Race: tool.start fires a tick before clarify.request, so request_id
  // arrives slightly after the tool block mounts. Hold the whole panel on a
  // spinner until the gateway request is wired — showing disabled choices or
  // a "loading question" stub is worse than a brief wait.
  const ready = Boolean(matchingRequest?.requestId)
  const loading = !ready && !submitting

  const respond = useCallback(
    async (answer: string) => {
      if (!ready) {
        notifyError(new Error(copy.notReady), copy.sendFailed)

        return
      }

      setSubmitting(true)

      try {
        const outcome = await respondClarify(answer, sessionKey)

        void triggerHaptic('submit')

        // `clarify.respond` is `allow_expired`: a question the backend's own
        // 5-minute timeout already popped answers OK and delivers nothing. The
        // agent has moved on, so there is no retry — but the words are still
        // the user's intent, so route them where a skipped clarify's late pick
        // goes: a quoted follow-up in the composer. Silently "succeeding" here
        // is how an answer disappears with the UI saying it was sent.
        if (outcome === 'expired' && answer.trim()) {
          requestComposerInsert(copy.lateAnswer(question, answer.trim()), { mode: 'block' })
          requestComposerFocus()
          notify({ kind: 'warning', message: copy.expiredAnswer })
        }
        // tool.complete lands next → ClarifyToolSettled.
      } catch (error) {
        notifyError(error, copy.sendFailed)
        setSubmitting(false)
      }
    },
    [copy, question, ready, sessionKey]
  )

  const trimmedDraft = draft.trim()

  // Multi-select answers go back as a JSON array — that is exactly what
  // `_parse_multi_select_response` reads. A single pick stays a bare string so
  // the historical single-select wire shape is untouched.
  const pendingAnswer =
    selectedChoices.length > 0
      ? multiSelect
        ? JSON.stringify(selectedChoices)
        : selectedChoices[0]
      : trimmedDraft || null

  const selectChoice = useCallback(
    (choice: string, index: number) => {
      // Picking a choice and typing are mutually exclusive answers.
      setDraft('')
      setSelectedChoices(current =>
        multiSelect
          ? current.includes(choice)
            ? current.filter(entry => entry !== choice)
            : [...current, choice]
          : [choice]
      )
      setActiveIndex(index)
    },
    [multiSelect]
  )

  // Keep the cursor in range when the choice set changes (never past "Other").
  useEffect(() => {
    setActiveIndex(index => Math.min(index, choices.length))
  }, [choices.length])

  const moveActive = useCallback(
    (delta: number) => {
      const itemCount = choices.length + 1

      // Arrow navigation is a move, not a pick — clear any staged answer so the
      // cursor and the selection cannot disagree about what Enter would send.
      setDraft('')
      setSelectedChoices([])
      setActiveIndex(index => (index + delta + itemCount) % itemCount)
    },
    [choices.length]
  )

  const submitAnswer = useCallback(() => {
    if (pendingAnswer) {
      void respond(pendingAnswer)
    }
  }, [pendingAnswer, respond])

  const activateActive = useCallback(() => {
    // A staged answer (picked choice or typed text) wins — confirm it.
    if (pendingAnswer) {
      submitAnswer()

      return
    }

    // Otherwise act on the highlighted row: a choice answers immediately, and
    // the trailing "Other" row focuses the free-text field. A multi-select
    // question has no "immediately" — Enter on a row picks it and waits for
    // the next one, because the answer is the SET.
    const choice = choices[activeIndex]

    if (choice) {
      if (multiSelect) {
        selectChoice(choice, activeIndex)
      } else {
        void respond(choice)
      }

      return
    }

    textareaRef.current?.focus()
  }, [activeIndex, choices, multiSelect, pendingAnswer, respond, selectChoice, submitAnswer])

  const handleTextareaKey = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.nativeEvent.isComposing) {
        return
      }

      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        submitAnswer()
      }
    },
    [submitAnswer]
  )

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      submitAnswer()
    },
    [submitAnswer]
  )

  // Arrow keys move the cursor, 1-9 and A/B/C… pick directly, and Enter
  // confirms the staged answer (or acts on the highlighted row). Stands down
  // whenever ANY focusable control holds focus — a field, a choice button, a
  // button in the action row — so it never eats a keystroke meant for the thing
  // the user actually tabbed to. Testing only INPUT/TEXTAREA (as this did) let
  // a focused Skip button lose its own Enter to this handler.
  useEffect(() => {
    if (!ready || !hasChoices || submitting) {
      return
    }

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) {
        return
      }

      // This listener is on the DOCUMENT, but the card is one surface among
      // many: keep-alive leaves an inactive tab's clarify mounted, and a split
      // can show two at once. Only the card the composer also yields to may act
      // — otherwise a background session's question ate the foreground's
      // letters, and Enter answered it with whatever its cursor happened to be
      // resting on. `keyOwningClarifyCard` is that single answer, shared with
      // `clarifyCardOwnsKey` so the two can never pick different cards.
      if (keyOwningClarifyCard() !== shellRef.current) {
        return
      }

      const active = document.activeElement as HTMLElement | null

      if (
        active &&
        (active.isContentEditable || active.matches('a[href], button, input, select, textarea, [role="button"]'))
      ) {
        return
      }

      // Mid-composition (IME) the key events describe the composition, not the
      // user's intent. WebKitGTK orders these differently from Chromium, so the
      // guard belongs on the GLOBAL handler too, not just the textarea's.
      if (event.isComposing) {
        return
      }

      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        moveActive(event.key === 'ArrowDown' ? 1 : -1)

        return
      }

      if (/^[1-9]$/.test(event.key)) {
        const index = Number(event.key) - 1

        if (index < choices.length) {
          event.preventDefault()
          selectChoice(choices[index], index)
        } else if (index === choices.length) {
          event.preventDefault()
          setActiveIndex(index)
          textareaRef.current?.focus()
        }

        return
      }

      const key = event.key.toLowerCase()

      // Only the letters this card actually renders a row for. Anything past
      // the last row belongs to the composer — the user is typing a message
      // instead of picking an option, and swallowing it here would make the
      // first letter of that message vanish.
      if (key.length === 1 && key >= 'a' && key <= 'z') {
        const index = key.charCodeAt(0) - 97

        if (index < choices.length) {
          event.preventDefault()
          selectChoice(choices[index], index)
        } else if (index === choices.length) {
          event.preventDefault()
          setActiveIndex(index)
          textareaRef.current?.focus()
        }

        return
      }

      if (event.key === 'Enter') {
        event.preventDefault()
        activateActive()
      }
    }

    window.addEventListener('keydown', onKeyDown)

    return () => window.removeEventListener('keydown', onKeyDown)
  }, [activateActive, choices, hasChoices, moveActive, ready, selectChoice, submitting])

  if (loading) {
    return (
      <ClarifyShell aria-label={copy.loadingQuestion} className="my-1.5 grid min-h-12 place-items-center" role="status">
        <Loader2 aria-hidden className="size-4 animate-spin text-(--ui-text-tertiary)" />
      </ClarifyShell>
    )
  }

  const onDraftChange = (value: string) => {
    setDraft(value)

    if (value.trim()) {
      setSelectedChoices([])
    }
  }

  return (
    // `data-clarify-choices` marks the panel as owning its OWN shortcut keys
    // (Enter, and 1..N+1 / A.. for the N choices plus "Other") while they're
    // live, so the global type-to-focus listener (`clarifyCardOwnsKey`) yields
    // exactly those and lets every other printable through to the composer —
    // typing a real message instead of picking an option stays possible. The
    // value is the choice count so the check needs no store access.
    //
    // The form is the outer element so the actions can sit OUTSIDE the card and
    // still submit it — the panel holds the question, the buttons ride below it.
    <form
      className="my-1.5 grid gap-4"
      data-clarify-choices={hasChoices ? choices.length : undefined}
      onSubmit={handleSubmit}
      ref={shellRef}
    >
      <ClarifyShell className="grid gap-2">
        <div className="flex items-start gap-2">
          <span className="flex-1 whitespace-pre-wrap font-medium leading-(--conversation-line-height)">
            {question}
          </span>
          <MessageQuestion aria-hidden className="mt-px size-4 shrink-0 text-(--ui-text-tertiary)" />
        </div>

        {hasChoices ? (
          <div className="grid gap-px" role="group">
            {choices.map((choice, index) => (
              <ChoiceButton
                active={activeIndex === index}
                char={letterFor(index)}
                choice={choice}
                disabled={submitting}
                key={`${index}-${choice}`}
                keyShortcuts={`${letterFor(index)} ${index + 1}`}
                onClick={() => selectChoice(choice, index)}
                selected={selectedChoices.includes(choice)}
              />
            ))}
            <label
              className={cn(
                OPTION_ROW_CLASS,
                'items-center',
                activeIndex === choices.length && 'bg-(--chrome-action-hover)'
              )}
              data-highlighted={activeIndex === choices.length || undefined}
            >
              <KeyBadge
                char={letterFor(choices.length)}
                preview={otherFocused || activeIndex === choices.length}
                selected={Boolean(trimmedDraft)}
              />
              <Textarea
                aria-current={activeIndex === choices.length || undefined}
                aria-keyshortcuts={`${letterFor(choices.length)} ${choices.length + 1}`}
                className={CLARIFY_TEXTAREA_CLASS}
                disabled={submitting}
                onBlur={() => setOtherFocused(false)}
                onChange={event => onDraftChange(event.target.value)}
                onFocus={() => {
                  setSelectedChoices([])
                  setActiveIndex(choices.length)
                  setOtherFocused(true)
                }}
                onKeyDown={handleTextareaKey}
                placeholder={copy.other}
                ref={textareaRef}
                rows={1}
                size="sm"
                value={draft}
              />
            </label>
          </div>
        ) : (
          <Textarea
            className={CLARIFY_TEXTAREA_CLASS}
            disabled={submitting}
            onChange={event => onDraftChange(event.target.value)}
            onKeyDown={handleTextareaKey}
            placeholder={copy.placeholder}
            ref={textareaRef}
            rows={1}
            size="sm"
            value={draft}
          />
        )}
      </ClarifyShell>

      <div className="flex items-center justify-end gap-1">
        <Button disabled={submitting} onClick={() => void respond('')} size="xs" type="button" variant="text">
          {copy.skip}
        </Button>
        <Button disabled={submitting || !pendingAnswer} size="xs" type="submit">
          {submitting ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <>
              {copy.continueLabel}
              <span aria-hidden className="ms-0.5 text-[0.625rem] opacity-70">
                ⏎
              </span>
            </>
          )}
        </Button>
      </div>
    </form>
  )
}

/** One question's staged answer: picked choices, or free text. */
interface StagedAnswer {
  choices: string[]
  draft: string
}

/** The wire answer for one staged question — `''` when the user left it blank
 *  (a deliberate per-question skip, which still counts as answered). */
function wireAnswer(question: ClarifyQuestion, staged: StagedAnswer | undefined): string {
  if (!staged) {
    return ''
  }

  if (staged.choices.length > 0) {
    // Multi-select answers go back as a JSON array — `_parse_multi_select_response`
    // in tools/clarify_tool.py reads exactly that. The label rides along; the
    // tool strips it (`strip_recommended`) before the model sees the answer.
    return question.multiSelect ? JSON.stringify(staged.choices) : staged.choices[0]
  }

  return staged.draft.trim()
}

/**
 * Has this question got a real answer?
 *
 * Touched-but-blank does NOT count: the card has no per-question skip (Skip
 * cancels the whole batch, which is the gateway's only partial-free exit), so
 * letting a cleared textbox satisfy the confirm gate would send the agent a
 * blank the user never meant to give it.
 */
const isAnswered = (question: ClarifyQuestion, staged: StagedAnswer | undefined): boolean =>
  wireAnswer(question, staged).length > 0

/**
 * The live BATCH clarify card.
 *
 * Every question renders at once and every answer stages LOCALLY: nothing
 * reaches the gateway until the single "Confirm and continue" press, which
 * sends the per-question locks back-to-back. That ordering is load-bearing —
 * the gateway completes the batch on the lock that empties `remaining`, so the
 * last one released the agent (see `respondClarifyBatch`).
 *
 * Skip is the batch's cancel: `clarify.respond` with NO `question_id` resolves
 * the whole request with an empty answer, and the tool reports every question
 * as unanswered.
 */
function ClarifyToolBatchPending({ args }: ToolCallMessagePartProps) {
  const { t } = useI18n()
  const copy = t.assistant.clarify
  const sessionKey = useStore(useSessionView().$runtimeId) ?? ''
  const request = useStore(sessionClarifyRequest(sessionKey))
  const fromArgs = useMemo(() => readClarifyArgs(args), [args])
  // The store leads for the same reason the single card gives it precedence:
  // `tool.start` ships no args, so the gateway event is the only source until
  // the tool completes.
  const questions = useMemo(() => request?.questions ?? fromArgs.questions ?? [], [fromArgs.questions, request])

  const [staged, setStaged] = useState<Record<string, StagedAnswer>>({})
  const [submitting, setSubmitting] = useState(false)

  const lockedAnswers = request?.lockedAnswers

  // A reconnect replays the answers the gateway already locked
  // (`_pending_clarify_request_payload`). Staging them back is what makes the
  // resumed card show the user's own work instead of an empty form they would
  // have to fill in again — and they stay editable, because a lock is
  // update-in-place server-side until the batch completes.
  useEffect(() => {
    if (!lockedAnswers) {
      return
    }

    setStaged(current => {
      const next = { ...current }
      let changed = false

      for (const question of questions) {
        const locked = lockedAnswers[question.qid]

        if (locked === undefined || question.qid in next) {
          continue
        }

        next[question.qid] = restoreStaged(question, locked)
        changed = true
      }

      return changed ? next : current
    })
  }, [lockedAnswers, questions])

  const answeredCount = questions.filter(question => isAnswered(question, staged[question.qid])).length
  const allStaged = questions.length > 0 && answeredCount === questions.length
  const ready = Boolean(request?.requestId)

  const setAnswer = useCallback((qid: string, value: StagedAnswer) => {
    setStaged(current => ({ ...current, [qid]: value }))
  }, [])

  const toggleChoice = useCallback(
    (question: ClarifyQuestion, choice: string) => {
      const current = staged[question.qid]?.choices ?? []

      if (!question.multiSelect) {
        setAnswer(question.qid, { choices: [choice], draft: '' })
        void triggerHaptic('selection')

        return
      }

      setAnswer(question.qid, {
        choices: current.includes(choice) ? current.filter(entry => entry !== choice) : [...current, choice],
        draft: ''
      })
      void triggerHaptic('selection')
    },
    [setAnswer, staged]
  )

  const confirmAll = useCallback(async () => {
    if (!ready) {
      notifyError(new Error(copy.notReady), copy.sendFailed)

      return
    }

    setSubmitting(true)

    try {
      const { outcome } = await respondClarifyBatch(
        questions.map(question => ({ questionId: question.qid, answer: wireAnswer(question, staged[question.qid]) })),
        sessionKey
      )

      void triggerHaptic('submit')

      // `clarify.respond` is `allow_expired`: the batch the deadline already
      // popped answers OK and delivers nothing. Say so rather than letting the
      // card look like it landed.
      if (outcome === 'expired') {
        notify({ kind: 'warning', message: copy.expiredAnswer })
      }
      // tool.complete lands next → ClarifyToolBatchSettled.
    } catch (error) {
      // 4002 is the one failure that is not "the send broke": the gateway is
      // alive and the batch is alive, this question just is not part of it.
      // Reporting that as a transport failure would send the user retrying a
      // lock that can never be accepted.
      notifyError(
        error,
        gatewayRpcErrorCode(error) === CLARIFY_UNKNOWN_QUESTION_CODE ? copy.unknownQuestion : copy.sendFailed
      )
      setSubmitting(false)
    }
  }, [copy, questions, ready, sessionKey, staged])

  const cancelAll = useCallback(async () => {
    setSubmitting(true)

    try {
      // No `question_id` — that is exactly what makes the gateway cancel the
      // WHOLE batch instead of locking one blank answer.
      await respondClarify('', sessionKey)
      void triggerHaptic('submit')
    } catch (error) {
      notifyError(error, copy.sendFailed)
      setSubmitting(false)
    }
  }, [copy, sessionKey])

  if (!ready && !submitting) {
    return (
      <ClarifyShell aria-label={copy.loadingQuestion} className="my-1.5 grid min-h-12 place-items-center" role="status">
        <Loader2 aria-hidden className="size-4 animate-spin text-(--ui-text-tertiary)" />
      </ClarifyShell>
    )
  }

  return (
    <form
      className="my-1.5 grid gap-4"
      data-clarify-batch={questions.length}
      onSubmit={event => {
        event.preventDefault()
        void confirmAll()
      }}
    >
      <ClarifyShell className="grid gap-3">
        {questions.map(question => (
          <BatchQuestionBlock
            answered={isAnswered(question, staged[question.qid])}
            answeredLabel={copy.answeredBadge}
            disabled={submitting}
            key={question.qid}
            onDraft={draft => setAnswer(question.qid, { choices: [], draft })}
            onToggle={choice => toggleChoice(question, choice)}
            otherLabel={copy.other}
            placeholder={copy.placeholder}
            question={question}
            staged={staged[question.qid]}
          />
        ))}
      </ClarifyShell>

      <div className="flex items-center justify-end gap-2">
        <span className="me-auto text-[0.6875rem] leading-4 text-(--ui-text-tertiary)">
          {copy.questionProgress(answeredCount, questions.length)}
        </span>
        <Button
          disabled={submitting}
          onClick={() => {
            void cancelAll()
          }}
          size="xs"
          type="button"
          variant="text"
        >
          {copy.skip}
        </Button>
        <Button disabled={submitting || !allStaged} size="xs" type="submit">
          {submitting ? <Loader2 className="size-3 animate-spin" /> : copy.confirmAndContinueLabel}
        </Button>
      </div>
    </form>
  )
}

/**
 * Put a replayed lock back into the card's staged state.
 *
 * A multi-select answer went out as a JSON array, so it has to come back
 * through `JSON.parse` or it restores as literal `["a","b"]` text in the
 * free-text box. Anything that does not match a choice this question offers is
 * free text — that is what the user typed.
 */
function restoreStaged(question: ClarifyQuestion, locked: string): StagedAnswer {
  const offered = question.choices ?? []
  const matching = (value: string) => offered.find(choice => choice === value || bareChoice(choice) === value)

  if (question.multiSelect) {
    try {
      const parsed: unknown = JSON.parse(locked)

      if (Array.isArray(parsed)) {
        const choices = parsed.flatMap(entry => {
          const found = typeof entry === 'string' ? matching(entry) : undefined

          return found ? [found] : []
        })

        if (choices.length > 0) {
          return { choices, draft: '' }
        }
      }
    } catch {
      // Not JSON — fall through and treat it as the free text it looks like.
    }
  }

  const choice = matching(locked)

  return choice ? { choices: [choice], draft: '' } : { choices: [], draft: locked }
}

/** One question of the live batch card: its text, its options, its free-text row. */
function BatchQuestionBlock({
  answered,
  answeredLabel,
  disabled,
  onDraft,
  onToggle,
  otherLabel,
  placeholder,
  question,
  staged
}: {
  answered: boolean
  answeredLabel: string
  disabled: boolean
  onDraft: (draft: string) => void
  onToggle: (choice: string) => void
  otherLabel: string
  placeholder: string
  question: ClarifyQuestion
  staged: StagedAnswer | undefined
}) {
  const choices = question.choices ?? []
  const picked = staged?.choices ?? []

  return (
    <div className="grid gap-1.5" data-clarify-question={question.qid}>
      <div className="flex items-start gap-2">
        <span className="flex-1 whitespace-pre-wrap font-medium leading-(--conversation-line-height)">
          {question.question}
        </span>
        {answered ? (
          <span className="mt-px shrink-0 text-[0.6875rem] leading-4 text-(--ui-text-tertiary)">{answeredLabel}</span>
        ) : null}
        <MessageQuestion aria-hidden className={CLARIFY_ICON_CLASS} />
      </div>

      {choices.length > 0 ? (
        <div className="grid gap-px" role="group">
          {choices.map((choice, index) => (
            <ChoiceButton
              char={letterFor(index)}
              choice={choice}
              disabled={disabled}
              key={`${index}-${choice}`}
              onClick={() => onToggle(choice)}
              selected={picked.includes(choice)}
            />
          ))}
          <Textarea
            className={CLARIFY_TEXTAREA_CLASS}
            disabled={disabled}
            onChange={event => onDraft(event.target.value)}
            placeholder={otherLabel}
            rows={1}
            size="sm"
            value={staged?.draft ?? ''}
          />
        </div>
      ) : (
        <Textarea
          className={CLARIFY_TEXTAREA_CLASS}
          disabled={disabled}
          onChange={event => onDraft(event.target.value)}
          placeholder={placeholder}
          rows={1}
          size="sm"
          value={staged?.draft ?? ''}
        />
      )}
    </div>
  )
}
