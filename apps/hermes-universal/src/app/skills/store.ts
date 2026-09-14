import { Codecs, persistentAtom } from '@/lib/persisted'

// Per-view sort direction for the Capabilities lists — persisted so each tab
// remembers most/least-used across navigations and restarts.
export const $skillsSortDesc = persistentAtom('hermes.desktop.capabilities.skillsSortDesc', true, Codecs.bool)
export const $toolsetsSortDesc = persistentAtom('hermes.desktop.capabilities.toolsetsSortDesc', true, Codecs.bool)

// The docked hub browser's pane-store key: its height, and the collapsed state
// the chevron writes (0), persist under it like every other pane. It lives in
// this leaf module rather than in the view so the command palette can reveal
// the hub without importing (and bundling) the whole Capabilities view.
export const HUB_PANE_ID = 'capabilities-hub'
