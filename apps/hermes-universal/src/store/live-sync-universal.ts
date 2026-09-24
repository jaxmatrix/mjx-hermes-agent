import { atom } from 'nanostores'

/** Backend plugin list changed — universal settings page refresh tick. */
export const $pluginsChangeTick = atom(0)

export function notifyPluginsChanged(): void {
  $pluginsChangeTick.set($pluginsChangeTick.get() + 1)
}
