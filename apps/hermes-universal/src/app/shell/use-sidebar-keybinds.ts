import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

import { NEW_CHAT_ROUTE } from '@/app/routes'
import { NEW_SESSION_FLASH_EVENT, requestSessionSearchFocus, toggleSidebarOpen } from '@/store/layout'
import { newSession } from '@/store/session'

// Sidebar keyboard shortcuts (parity with desktop): mod+b toggles the sidebar,
// mod+shift+f focuses the sessions search, mod+n starts a fresh session (and
// flashes its ⌘N rail hint). Mounted once, connected-only, inside the router.
export function useSidebarKeybinds(): void {
  const navigate = useNavigate()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (!mod || e.altKey) return

      const key = e.key.toLowerCase()

      if (key === 'b' && !e.shiftKey) {
        e.preventDefault()
        toggleSidebarOpen()
        return
      }

      if (key === 'f' && e.shiftKey) {
        e.preventDefault()
        requestSessionSearchFocus()
        return
      }

      if (key === 'n') {
        e.preventDefault()
        newSession()
        navigate(NEW_CHAT_ROUTE)
        window.dispatchEvent(new CustomEvent(NEW_SESSION_FLASH_EVENT))
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navigate])
}
