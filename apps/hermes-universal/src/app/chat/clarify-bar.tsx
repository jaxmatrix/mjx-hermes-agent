import { useState } from 'react'

import { type ClarifyRequest, respondClarify } from '@/store/chat'

export function ClarifyBar({ request }: { request: ClarifyRequest }) {
  const [answer, setAnswer] = useState('')
  const submit = () => {
    if (answer.trim()) void respondClarify(answer.trim())
  }
  return (
    <div className="approval">
      <div className="approval-head">Clarification needed</div>
      <div className="approval-desc" style={{ fontFamily: 'inherit' }}>
        {request.prompt}
      </div>
      <input
        autoFocus
        className="field"
        onChange={e => setAnswer(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && submit()}
        placeholder="Your answer"
        value={answer}
      />
      <div className="approval-actions">
        <button className="btn btn-sm btn-primary" disabled={!answer.trim()} onClick={submit}>
          Send
        </button>
      </div>
    </div>
  )
}
