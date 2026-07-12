import { useRef, useState } from 'react'

import { useStore } from '@/store/atom'
import { $busy, sendPrompt } from '@/store/chat'

export function Composer() {
  const busy = useStore($busy)
  const [text, setText] = useState('')
  const areaRef = useRef<HTMLTextAreaElement>(null)

  const grow = () => {
    const el = areaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }

  const submit = () => {
    const value = text.trim()
    if (!value || busy) return
    void sendPrompt(value)
    setText('')
    requestAnimationFrame(() => {
      if (areaRef.current) areaRef.current.style.height = 'auto'
    })
  }

  return (
    <div className="composer">
      <textarea
        ref={areaRef}
        className="composer-input"
        rows={1}
        placeholder="Message Hermes…"
        value={text}
        onChange={e => {
          setText(e.target.value)
          grow()
        }}
      />
      <button className="composer-send" disabled={!text.trim() || busy} onClick={submit} aria-label="Send">
        ↑
      </button>
    </div>
  )
}
