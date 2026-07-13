import { useState } from 'react'

import { respondSecret, type SecretRequest } from '@/store/chat'

export function SecretBar({ request }: { request: SecretRequest }) {
  const [value, setValue] = useState('')
  const submit = () => {
    if (value) void respondSecret(value)
  }
  return (
    <div className="approval">
      <div className="approval-head">Secret required{request.envVar ? `: ${request.envVar}` : ''}</div>
      {request.prompt && (
        <div className="approval-desc" style={{ fontFamily: 'inherit' }}>
          {request.prompt}
        </div>
      )}
      <input
        autoFocus
        className="field"
        onChange={e => setValue(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && submit()}
        placeholder={request.envVar || 'Value'}
        type="password"
        value={value}
      />
      <div className="approval-actions">
        <button className="btn btn-sm btn-primary" disabled={!value} onClick={submit}>
          Submit
        </button>
      </div>
    </div>
  )
}
