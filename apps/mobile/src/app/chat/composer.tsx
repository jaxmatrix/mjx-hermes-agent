import { useEffect, useRef, useState } from 'react'

import { pickAttachment, type StagedAttachment } from '@/app/chat/attachments'
import {
  applyCompletion,
  type CompletionEntry,
  detectTrigger,
  displayText,
  fetchCompletions
} from '@/app/chat/composer-completions'
import { useVoiceRecorder } from '@/app/chat/use-voice-recorder'
import { useStore } from '@/store/atom'
import { $busy, sendPrompt } from '@/store/chat'
import { $history, dequeue, enqueue, pushHistory } from '@/store/composer'
import { triggerHaptic } from '@/store/haptics'

export function Composer() {
  const busy = useStore($busy)
  const history = useStore($history)
  const [text, setText] = useState('')
  const [staged, setStaged] = useState<StagedAttachment[]>([])
  const [items, setItems] = useState<CompletionEntry[]>([])
  const [replaceFrom, setReplaceFrom] = useState(0)
  const [histIndex, setHistIndex] = useState(-1)
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const nextCursor = useRef<number | null>(null)
  const fetchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const voice = useVoiceRecorder(transcript => {
    setText(prev => (prev ? `${prev.trimEnd()} ${transcript}` : transcript))
    requestAnimationFrame(() => areaRef.current?.focus())
  })

  // Auto-send the next queued prompt once the turn frees up.
  useEffect(() => {
    if (busy) return
    const queued = dequeue()
    if (queued) void sendPrompt(queued)
  }, [busy])

  // Restore the caret after a completion insert.
  useEffect(() => {
    if (nextCursor.current != null && areaRef.current) {
      areaRef.current.selectionStart = areaRef.current.selectionEnd = nextCursor.current
      nextCursor.current = null
    }
  })

  const grow = () => {
    const el = areaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }

  const closeDrawer = () => setItems([])

  const refresh = (value: string, cursor: number) => {
    clearTimeout(fetchTimer.current)
    const trigger = detectTrigger(value, cursor)
    if (!trigger) {
      closeDrawer()
      return
    }
    fetchTimer.current = setTimeout(() => {
      void fetchCompletions(trigger).then(res => {
        setItems(res.items)
        setReplaceFrom(res.replaceFrom)
      })
    }, 120)
  }

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value
    setText(value)
    setHistIndex(-1)
    grow()
    refresh(value, e.target.selectionStart ?? value.length)
  }

  const pick = (entry: CompletionEntry) => {
    const cursor = areaRef.current?.selectionStart ?? text.length
    const applied = applyCompletion(text, cursor, replaceFrom, entry)
    setText(applied.text)
    nextCursor.current = applied.cursor
    closeDrawer()
    requestAnimationFrame(() => areaRef.current?.focus())
  }

  const attach = () => {
    void pickAttachment()
      .then(a => {
        if (a) setStaged(prev => [...prev, a])
      })
      .catch(() => {
        /* picker cancelled / unavailable */
      })
  }

  const submit = () => {
    const value = text.trim()
    if (!value && staged.length === 0) return
    // Attachment refs (@file:/@image:) are spliced into the prompt text.
    const full = [...staged.map(a => a.ref), value].filter(Boolean).join(' ')
    void triggerHaptic('submit')
    if (value) pushHistory(value)
    setText('')
    setStaged([])
    setHistIndex(-1)
    closeDrawer()
    if (busy) enqueue(full)
    else void sendPrompt(full)
    requestAnimationFrame(() => {
      if (areaRef.current) areaRef.current.style.height = 'auto'
    })
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape' && items.length > 0) {
      e.preventDefault()
      closeDrawer()
      return
    }
    // History: ArrowUp/Down when the caret is at the very start and no drawer.
    const atStart = (areaRef.current?.selectionStart ?? 0) === 0 && items.length === 0
    if (e.key === 'ArrowUp' && atStart && history.length > 0) {
      e.preventDefault()
      const i = Math.min(histIndex + 1, history.length - 1)
      setHistIndex(i)
      setText(history[i])
      return
    }
    if (e.key === 'ArrowDown' && histIndex >= 0) {
      e.preventDefault()
      const i = histIndex - 1
      setHistIndex(i)
      setText(i < 0 ? '' : history[i])
      return
    }
  }

  return (
    <div className="composer-wrap">
      {items.length > 0 && (
        <ul className="completion-drawer">
          {items.slice(0, 8).map((entry, i) => (
            <li key={`${entry.text}-${i}`}>
              <button className="completion-item" onClick={() => pick(entry)} type="button">
                {displayText(entry)}
              </button>
            </li>
          ))}
        </ul>
      )}
      {staged.length > 0 && (
        <div className="attach-chips">
          {staged.map((a, i) => (
            <span className="attach-chip" key={`${a.ref}-${i}`}>
              {a.name}
              <button
                aria-label={`Remove ${a.name}`}
                onClick={() => setStaged(prev => prev.filter((_, j) => j !== i))}
                type="button"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="composer">
        <button aria-label="Attach file" className="composer-attach" onClick={attach} type="button">
          ＋
        </button>
        <button
          aria-label={voice.recording ? 'Stop recording' : 'Voice input'}
          className={`composer-mic${voice.recording ? ' recording' : ''}`}
          disabled={voice.transcribing}
          onClick={voice.toggle}
          type="button"
        >
          {voice.transcribing ? '…' : voice.recording ? '■' : '🎙'}
        </button>
        <textarea
          ref={areaRef}
          className="composer-input"
          onChange={onChange}
          onKeyDown={onKeyDown}
          placeholder={busy ? 'Queue a message…' : 'Message Hermes…'}
          rows={1}
          value={text}
        />
        <button
          aria-label="Send"
          className="composer-send"
          disabled={!text.trim() && staged.length === 0}
          onClick={submit}
        >
          ↑
        </button>
      </div>
    </div>
  )
}
