/**
 * Build the SDK sample plugins into runtime-loadable `plugin.js` artifacts and
 * install them into the disk door.
 *
 * The samples are authored as app source (`.tsx`, relative imports, a css file)
 * and are normally compiled INTO desktop's bundle by the vite glob. The runtime
 * loader can't take that: it blob-imports a single ESM module, and a blob URL
 * has no base to resolve `./api` against. So each sample is bundled to one file
 * with the four specifiers the loader's import map understands left external —
 * exactly the shape a third-party plugin ships in.
 *
 * Untracked on purpose: this is a local test fixture, not part of PR #50. The
 * real delivery mechanism is MJX-269.
 *
 *   node scripts/build-sample-plugins.mjs [--src <dir>] [--out <dir>]
 */

import { mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import * as esbuild from 'esbuild'

const { values } = parseArgs({
  options: {
    src: { type: 'string', default: join(homedir(), '.hermes/hermes-agent/apps/desktop/src/plugins') },
    out: { type: 'string', default: join(homedir(), '.hermes/desktop-plugins') }
  }
})

const SRC = resolve(values.src)
const OUT = resolve(values.out)

// Only these reach the loader's `sdkImportMap()` (src/sdk/runtime.ts). Anything
// else left bare is rejected up-front as an unsupported import, so bundle it.
const EXTERNAL = ['@hermes/plugin-sdk', 'react', 'react/jsx-runtime', 'react/jsx-dev-runtime']

// A plugin's stylesheet has nowhere to go in a single ESM module — turn the
// import into a side effect that injects a <style>, keyed so a hot reload
// replaces it instead of stacking copies.
const cssAsStyleTag = {
  name: 'css-as-style-tag',
  setup(build) {
    build.onLoad({ filter: /\.css$/ }, args => {
      const key = `hermes-plugin-style:${args.path}`

      return {
        loader: 'js',
        contents: `
          const KEY = ${JSON.stringify(key)}
          const el = document.querySelector(\`style[data-plugin-style="\${KEY}"]\`) ?? document.createElement('style')
          el.dataset.pluginStyle = KEY
          el.textContent = ${JSON.stringify(readFileSync(args.path, 'utf8'))}
          if (!el.isConnected) document.head.append(el)
        `
      }
    })
  }
}

const SAMPLES = [
  { name: 'gateway-pill', entry: 'gateway-pill/plugin.tsx' },
  { name: 'kanban', entry: 'kanban/plugin.tsx' },
  { name: 'example', entry: 'example/plugin.tsx' }
]

for (const sample of SAMPLES) {
  const outfile = join(OUT, sample.name, 'plugin.js')
  mkdirSync(join(OUT, sample.name), { recursive: true })

  await esbuild.build({
    entryPoints: [join(SRC, sample.entry)],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    // Automatic runtime -> `react/jsx-runtime`, which the import map covers.
    jsx: 'automatic',
    external: EXTERNAL,
    plugins: [cssAsStyleTag],
    logLevel: 'warning'
  })

  console.log(`built ${sample.name} -> ${outfile}`)
}
