import { computed } from 'nanostores'

import { $approval, $clarify, $secret, $sudo } from '@/store/chat'

// The active turn is parked waiting on the user (a clarify / approval / sudo /
// secret prompt is open). The composer's Esc handling reads this to avoid
// interrupting a turn that's actually waiting for input. Desktop scopes this per
// session; universal tracks a single active session, so a global boolean matches.
export const $activeSessionAwaitingInput = computed(
  [$clarify, $approval, $sudo, $secret],
  (clarify, approval, sudo, secret) => Boolean(clarify || approval || sudo || secret)
)
