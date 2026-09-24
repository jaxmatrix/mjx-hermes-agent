import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useI18n } from '@/i18n'
import { useStore } from '@/store/atom'
import {
  $sshHostKey,
  $sshPrompt,
  answerActiveSshPrompt,
  cancelActiveSshPrompt,
  decideActiveSshHostKey
} from '@/store/ssh-backend'

// The two questions an SSH operation can stop and ask: a credential, and whether
// to trust a host key we have never seen.
//
// One component, mounted once, reading shared atoms — rather than living inside
// SshPanel as it used to. Desktop ran `ssh` with BatchMode=yes and so could never
// ask anything; we can, and the moment a SECOND caller existed (installing Hermes
// on the remote, which authenticates exactly like a connect) the panel-owned
// version left it asking into a void until the 60s timeout killed it.
//
// Mounted ONCE per window, in `app.tsx` beside `<ConfirmHost/>` (MJXHRM-592): a
// switch, a tunnel's Connect or an install can ask from anywhere, and a dialog
// that lived inside the configurator left every other caller asking into a void
// until the 60 s timeout. Two mounted copies would both render the same pending
// question, and the first answer would clear the atom out from under the second.
// A surface that wants to keep an answer subscribes with
// `addSshPromptAnswerListener`.

export function SshPromptDialog() {
  const { t } = useI18n()
  const g = t.settings.gateway
  const prompt = useStore($sshPrompt)
  const hostKey = useStore($sshHostKey)
  const [answer, setAnswer] = useState('')

  // A fresh box per question. Without this, the answer to a key passphrase is
  // still sitting in the field when the next question — often the login password
  // — arrives, and pressing Enter submits the wrong secret.
  useEffect(() => {
    setAnswer('')
  }, [prompt?.promptId])

  const submit = () => {
    if (!prompt) {
      return
    }

    void answerActiveSshPrompt(answer)
    setAnswer('')
  }

  // Trust-on-first-use. A CHANGED key never reaches here — it is refused
  // outright in Rust, under every policy. Asked first: the host key is checked
  // before any credential is.
  if (hostKey) {
    return (
      <Dialog onOpenChange={open => !open && void decideActiveSshHostKey(false)} open>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{g.sshHostKeyTitle}</DialogTitle>
            <DialogDescription>{g.sshHostKeyDesc(hostKey.host, hostKey.fingerprint)}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={() => void decideActiveSshHostKey(false)} variant="ghost">
              {g.sshHostKeyReject}
            </Button>
            <Button onClick={() => void decideActiveSshHostKey(true)}>{g.sshHostKeyTrust}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }

  if (!prompt) {
    return null
  }

  return (
    // Dismissing is a decision, like the Cancel button: the attempt stops rather
    // than waiting out its timeout.
    <Dialog onOpenChange={open => !open && void cancelActiveSshPrompt()} open>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{g.sshPromptTitle}</DialogTitle>
          <DialogDescription>{prompt.label}</DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          className="font-normal"
          onChange={event => setAnswer(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              submit()
            }
          }}
          // Per QUESTION, not per kind: keyboard-interactive is the one
          // exchange that legitimately asks things the server wants echoed.
          type={prompt.secret ? 'password' : 'text'}
          value={answer}
        />
        <DialogFooter>
          <Button onClick={() => void cancelActiveSshPrompt()} variant="ghost">
            {t.common.cancel}
          </Button>
          <Button onClick={submit}>{g.sshConnect}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
