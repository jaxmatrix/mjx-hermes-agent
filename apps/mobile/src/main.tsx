import { QueryClientProvider } from '@tanstack/react-query'
import { createRoot } from 'react-dom/client'

import { App } from './app'
import { queryClient } from './lib/query-client'
import './styles.css'

const container = document.getElementById('root')
if (!container) {
  throw new Error('root container missing')
}
createRoot(container).render(
  <QueryClientProvider client={queryClient}>
    <App />
  </QueryClientProvider>
)
