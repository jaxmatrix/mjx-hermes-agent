import globals from 'globals'

import shared from '../../eslint.config.shared.mjs'

export default [
  ...shared,
  {
    // Universal is a Tauri webview (desktop + Android + iOS), so it uses browser
    // globals throughout. The shared config only supplies globals.node, so that
    // terminal-only workspaces (ui-tui) don't silently get DOM types — same
    // re-addition apps/desktop makes for the Electron renderer.
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node
      }
    }
  },
  {
    // The perf bench is a plain script served straight to the browser, not part
    // of the app's module graph — it has no TS build step and legitimately uses
    // script-scope globals.
    ignores: ['bench/**']
  }
]
