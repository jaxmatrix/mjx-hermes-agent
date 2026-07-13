import { useState } from 'react'

import { respondSudo, type SudoRequest } from '@/store/chat'

export function SudoBar({ request }: { request: SudoRequest }) {
  const [password, setPassword] = useState('')
  const submit = () => {
    if (password) void respondSudo(password)
  }
  return (
    <div className="approval">
      <div className="approval-head">Sudo password required</div>
      <div className="approval-desc" style={{ fontFamily: 'inherit' }}>
        {request.prompt}
      </div>
      <input
        autoFocus
        className="field"
        onChange={e => setPassword(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && submit()}
        placeholder="Password"
        type="password"
        value={password}
      />
      <div className="approval-actions">
        <button className="btn btn-sm btn-primary" disabled={!password} onClick={submit}>
          Submit
        </button>
        <button className="btn btn-sm btn-danger" onClick={() => void respondSudo('')}>
          Cancel
        </button>
      </div>
    </div>
  )
}
