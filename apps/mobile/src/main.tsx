import { QueryClientProvider } from '@tanstack/react-query'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'

import { App } from './app'
import { ErrorBoundary } from './components/error-boundary'
import { queryClient } from './lib/query-client'
import 'katex/dist/katex.min.css'
import './styles.css'

const container = document.getElementById('root')
if (!container) {
  throw new Error('root container missing')
}
// FIXME(I): mount I18nProvider / ThemeProvider / HapticsProvider here (Track I).
createRoot(container).render(
  <ErrorBoundary>
    <QueryClientProvider client={queryClient}>
      <HashRouter>
        <App />
      </HashRouter>
    </QueryClientProvider>
  </ErrorBoundary>
)
