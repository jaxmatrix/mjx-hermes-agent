import { useEffect, useState } from 'react'

// Step-1 hello screen. Proves the Vite build + Tauri v2 Android shell + webview
// render on a real device. It also probes the Tauri IPC bridge so we can confirm
// the webview is genuinely running inside Tauri (not just a plain browser tab) —
// the real chat UI + Rust transport land in Step 2.
export function App() {
  const [tauri, setTauri] = useState<string>('checking…')

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const { getName, getVersion, getTauriVersion } = await import('@tauri-apps/api/app')
        const [name, version, tauriVersion] = await Promise.all([getName(), getVersion(), getTauriVersion()])
        if (!cancelled) {
          setTauri(`${name} v${version} · Tauri ${tauriVersion}`)
        }
      } catch (err) {
        if (!cancelled) {
          setTauri(`IPC unavailable: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <main className="hello">
      <div className="brand">Hermes</div>
      <h1>Mobile shell is alive</h1>
      <p className="sub">Step 1 — Tauri v2 Android debug build on a real device.</p>
      <div className="chip">{tauri}</div>
      <p className="next">Next: Rust transport core + the chat UI.</p>
    </main>
  )
}
