import { useState } from 'react'

import { RequestBar, RequestBarActions, RequestBarDescription } from '@/app/chat/request-bar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { type ClarifyRequest, respondClarify } from '@/store/chat'

export function ClarifyBar({ request }: { request: ClarifyRequest }) {
  const [answer, setAnswer] = useState('')

  const submit = () => {
    if (answer.trim()) {
      void respondClarify(answer.trim())
    }
  }

  return (
    <RequestBar title="Clarification needed">
      <RequestBarDescription>{request.prompt}</RequestBarDescription>
      <Input
        autoFocus
        onChange={e => setAnswer(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && submit()}
        placeholder="Your answer"
        value={answer}
      />
      <RequestBarActions>
        <Button disabled={!answer.trim()} onClick={submit} size="sm">
          Send
        </Button>
      </RequestBarActions>
    </RequestBar>
  )
}
