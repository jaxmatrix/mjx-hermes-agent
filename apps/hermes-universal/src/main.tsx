import { QueryClientProvider } from '@tanstack/react-query'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'

import { App } from './app'
import { ErrorBoundary } from './components/error-boundary'
import { I18nProvider } from './i18n'
import { queryClient } from './lib/query-client'
import { restoreSessionCookies } from './lib/session-persist'
import { ThemeProvider } from './themes'
import '@fontsource-variable/inter/wght.css'
import 'katex/dist/katex.min.css'
import '@vscode/codicons/dist/codicon.css'
import 'overlayscrollbars/overlayscrollbars.css'
import './styles.css'

// Rehydrate a persisted gateway/cloud session into the Rust cookie jar (R2b)
// before the user can reach the connect action. Fire-and-forget: the keyring read
// completes long before any user-initiated connect, and a failure degrades to a
// fresh sign-in rather than blocking startup.
void restoreSessionCookies()

const container = document.getElementById('root')
if (!container) {
  throw new Error('root container missing')
}
createRoot(container).render(
  <ErrorBoundary>
    <I18nProvider>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <HashRouter>
            <App />
          </HashRouter>
        </QueryClientProvider>
      </ThemeProvider>
    </I18nProvider>
  </ErrorBoundary>
)
