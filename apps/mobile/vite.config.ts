import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// Tauri expects a fixed dev port and a non-clearing console. For Android
// device dev the host must be reachable from the phone, so bind 0.0.0.0.
const host = process.env.TAURI_DEV_HOST

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Tailwind v4 is handled entirely by `@tailwindcss/vite`; pin an explicit
  // empty PostCSS config so Vite doesn't walk UP the filesystem and pick up a
  // stray postcss/tailwind config from the install location (see desktop
  // vite.config.ts for the same guard).
  css: { postcss: { plugins: [] } },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  clearScreen: false,
  server: {
    host: host || '0.0.0.0',
    port: 5176,
    strictPort: true,
    hmr: host ? { protocol: 'ws', host, port: 5177 } : undefined
  },
  build: {
    // Android System WebView baseline — keep the transpile target conservative.
    target: 'es2021',
    minify: process.env.TAURI_DEBUG ? false : 'esbuild',
    sourcemap: !!process.env.TAURI_DEBUG
  }
})
