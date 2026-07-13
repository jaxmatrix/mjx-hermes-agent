import { QueryClientProvider } from '@tanstack/react-query'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'

import { App } from './app'
import { ErrorBoundary } from './components/error-boundary'
import { I18nProvider } from './i18n'
import { queryClient } from './lib/query-client'
import { ThemeProvider } from './themes'
import 'katex/dist/katex.min.css'
import './styles.css'

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
