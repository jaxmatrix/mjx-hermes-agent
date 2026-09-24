/**
 * `hermesDesktop.wakeIndicator`, over universal's wake light.
 *
 * On Electron the main process holds the state and an always-on-top window
 * mirrors it. Universal splits it differently (`store/wake-indicator.ts`): the
 * state is an ATOM, and the presentations subscribe — the in-window pill, and
 * the driver of the native light (`app/wake-indicator/native-indicator.ts`),
 * which opens the `?win=wake` satellite and tells it each state over the
 * webview event bus (`app/wake-indicator/channel.ts`).
 *
 * Desktop's code only knows the namespace, so the two ends are joined here:
 *
 *   - `setState` — desktop's `lib/wake-indicator.ts` state machine, in the
 *     window that heard the phrase — writes the atom. Without it the atom has
 *     no writer and neither light ever comes on.
 *   - `onState` / `getState` — desktop's `WakeIndicatorApp`, which desktop's
 *     entry mounts in the `?win=wake` window — read the channel. `onState` also
 *     says hello, which is what makes the driver repeat the state it sent
 *     before this window was listening.
 *
 * All three members or none: a caller guards the NAMESPACE, never a member.
 */

import { emitWakeIndicatorHello, onWakeIndicatorState } from '@/app/wake-indicator/channel'
import { $wakeIndicator, WAKE_INDICATOR_STATES, type WakeIndicatorState } from '@/store/wake-indicator'

type WakeIndicatorBridge = NonNullable<NonNullable<typeof window.hermesDesktop>['wakeIndicator']>

const isState = (value: unknown): value is WakeIndicatorState =>
  (WAKE_INDICATOR_STATES as readonly unknown[]).includes(value)

function setState(state: WakeIndicatorState): void {
  if (isState(state) && state !== $wakeIndicator.get()) {
    $wakeIndicator.set(state)
  }
}

export const wakeIndicatorBridge: WakeIndicatorBridge = {
  getState: async () => $wakeIndicator.get(),
  onState: callback => {
    let gone = false
    let stop: (() => void) | undefined

    void onWakeIndicatorState(payload => {
      if (gone || !isState(payload)) {
        return
      }

      // This window's copy, so a later `getState` agrees with what was heard.
      setState(payload)
      callback(payload)
    }).then(off => {
      if (gone) {
        off()

        return
      }

      stop = off
      void emitWakeIndicatorHello()
    })

    return () => {
      gone = true
      stop?.()
    }
  },
  setState
}
