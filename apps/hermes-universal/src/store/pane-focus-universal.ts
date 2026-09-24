/**
 * Host aliases for backend/shell-bridge names that desktop keeps as
 * `revealDesktopPane` / `applyDesktopLayoutPreset`. Protected — do not fold
 * into AUTO `pane-focus.ts`.
 */
export {
  applyDesktopLayoutPreset as applyBridgeLayoutPreset,
  revealDesktopPane as revealBridgePane
} from '@/store/pane-focus'
