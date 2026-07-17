import { useEffect, useState } from 'react'

const isDarkNow = () => typeof document !== 'undefined' && document.documentElement.classList.contains('dark')

// Tracks the app's dark/light mode off the `dark` class on <html> (toggled by
// themes/context.tsx). Embeds that theme their own content (mermaid, tweets,
// iframes) read this. A MutationObserver on documentElement's `class` attribute
// keeps it live; setState bails on an unchanged boolean, so unrelated class
// changes don't re-render.
export function useIsDark(): boolean {
  const [dark, setDark] = useState(isDarkNow)

  useEffect(() => {
    const root = document.documentElement
    const sync = () => setDark(isDarkNow())

    sync()

    const observer = new MutationObserver(sync)

    observer.observe(root, { attributeFilter: ['class'], attributes: true })

    return () => observer.disconnect()
  }, [])

  return dark
}
