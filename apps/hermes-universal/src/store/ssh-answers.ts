import type { SshPromptEvent } from '@/store/ssh-backend'

/** A prompt answer worth keeping, in the shape the credential writers take. */
export type KeptSshAnswer = { passphrase: string } | { password: string }

/**
 * Which SSH prompt answers are kept, and as what (MJXHRM-592).
 *
 * The rules the configurator has always applied, shared so a tunnel's Connect
 * keeps exactly the same things: a passphrase or a password. A
 * `keyboard-interactive` answer is never kept — that exchange is where a
 * one-time code lives, and a stored OTP is both useless next time and a
 * credential we were never meant to hold. An empty answer keeps nothing.
 */
export function keptSshAnswer(kind: SshPromptEvent['kind'], answer: string): KeptSshAnswer | null {
  if (!answer || kind === 'keyboard-interactive') {
    return null
  }

  return kind === 'password' ? { password: answer } : { passphrase: answer }
}
