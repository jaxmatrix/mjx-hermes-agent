import { atom } from '@/store/atom'

// The lightweight command/overflow menu. The picture-perfect sidebar rail shows
// only the 4 desktop items (New session · Capabilities · Messaging · Artifacts);
// every other view (Agents, Files, Review, Starmap, Command Center, Settings…)
// is reached through this menu — opened by ⌘K, the titlebar search button
// (desktop), or the in-drawer button (phones, where there is no titlebar).
export const $commandMenuOpen = atom(false)

export const openCommandMenu = () => $commandMenuOpen.set(true)
export const closeCommandMenu = () => $commandMenuOpen.set(false)
export const toggleCommandMenu = () => $commandMenuOpen.set(!$commandMenuOpen.get())
