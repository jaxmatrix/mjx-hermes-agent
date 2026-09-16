import { useState } from 'react'

import { RequestBar, RequestBarActions, RequestBarDescription } from '@/app/chat/request-bar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useI18n } from '@/i18n'
import { respondSudo, type SudoRequest } from '@/store/chat'
import { notify, notifyError } from '@/store/notifications'

export function SudoBar({ request: _request, sessionKey }: { request: SudoRequest; sessionKey: string }) {
  const { t } = useI18n()
  const [password, setPassword] = useState('')
  // The bar stays until the gateway has the answer (MJXHRM-418): a swallowed
  // rejection used to tear it down while the sudo prompt was still blocking the
  // agent, with no way to answer it a second time.
  const [sending, setSending] = useState(false)

  const send = async (value: string) => {
    setSending(true)

    try {
      // `expired` means the request was already withdrawn: the command it was
      // for is cancelled, so a bar that just vanishes would read as "password
      // accepted".
      if ((await respondSudo(value, sessionKey)) === 'expired') {
        notify({
          kind: 'warning',
          message: 'That sudo prompt had already timed out — the command was cancelled, so the password went nowhere.'
        })
      }
    } catch (error) {
      notifyError(error, 'Sudo response failed to send')
    } finally {
      setSending(false)
    }
  }

  const submit = () => {
    if (password) {
      void send(password)
    }
  }

  return (
    <RequestBar title="Sudo password required">
      {/*
        The description is LOCAL copy now (MJXHRM-520). The `sudo` server
        request carries `EmptyRequestParams` — the session id and nothing else —
        so the shell's own prompt text that the retired `sudo.request` event used
        to forward no longer exists on the wire. `prompts.sudoDesc` already ships
        in all five locales, so this says the one thing worth saying here: where
        the password goes.
      */}
      <RequestBarDescription>{t.prompts.sudoDesc}</RequestBarDescription>
      <Input
        autoFocus
        onChange={e => setPassword(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && submit()}
        placeholder="Password"
        type="password"
        value={password}
      />
      <RequestBarActions>
        <Button disabled={!password || sending} onClick={submit} size="sm">
          Submit
        </Button>
        <Button disabled={sending} onClick={() => void send('')} size="sm" variant="outline">
          Cancel
        </Button>
      </RequestBarActions>
    </RequestBar>
  )
}
