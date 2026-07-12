import { createRoot } from 'react-dom/client'

import { App } from './app'
import './styles.css'

const container = document.getElementById('root')
if (!container) {
  throw new Error('root container missing')
}
createRoot(container).render(<App />)
