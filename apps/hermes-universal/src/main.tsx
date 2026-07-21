import 'katex/dist/katex.min.css'
import '@vscode/codicons/dist/codicon.css'
import './styles.css'

import { QueryClientProvider } from '@tanstack/react-query'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'

import { App } from './app'
import { ErrorBoundary } from './components/error-boundary'
import { HapticsProvider } from './components/haptics-provider'
import { I18nProvider } from './i18n'
import { warmKatexFonts } from './lib/katex-fonts'
import { queryClient } from './lib/query-client'
import { restoreSessionCookies } from './lib/session-persist'
import { autoRestoreConnection } from './store/gateway-restore'
import { ThemeProvider } from './themes'

// Rehydrate a persisted gateway/cloud session into the Rust cookie jar (R2b), THEN
// auto-reconnect to the last-used gateway (D8). Cookies first so a cookie-backed
// login (ticket/oauth/cloud) re-dials without an interactive sign-in; the restore
// runs even if the cookie read fails (it degrades to a fresh sign-in). `$restoring`
// is seeded true synchronously from the saved target, so the connecting screen —
// not the picker — shows from the first paint while this resolves.
void restoreSessionCookies().finally(() => {
  void autoRestoreConnection()
})

// Pull KaTeX's faces in at idle. They are `font-display: block`, so the first
// equation of a session otherwise renders INVISIBLE until they land (see
// lib/katex-fonts).
warmKatexFonts()

const container = document.getElementById('root')

if (!container) {
  throw new Error('root container missing')
}

createRoot(container).render(
  <ErrorBoundary>
    <I18nProvider>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <HapticsProvider>
            <HashRouter>
              <App />
            </HashRouter>
          </HapticsProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </I18nProvider>
  </ErrorBoundary>
)
