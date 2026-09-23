/**
 * Terminal pane open preference + modeBound shadowing.
 *
 * Desktop layout no longer exports `$terminalOpen` / `setTerminalOpen`; universal
 * chrome (header, rail, terminals store) still uses those names. Protected so
 * absorb cannot wipe the bridge.
 */
import { Codecs, persistentAtom } from '@/lib/persisted'
import { modeBound } from '@/store/interface-mode'

const $terminalOpenPref = persistentAtom('hermes.terminalOpen', false, Codecs.bool)

export const $terminalOpen = modeBound('terminalOpen', $terminalOpenPref, open => $terminalOpenPref.set(open))

export function setTerminalOpen(open: boolean): void {
  $terminalOpen.set(open)
}

export function toggleTerminalOpen(): void {
  $terminalOpen.set(!$terminalOpen.get())
}
