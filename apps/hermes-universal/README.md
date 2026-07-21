# Hermes Universal

Tauri v2 client — desktop, Android and iOS from one codebase.

## Linux build prerequisites

The webview and the bundlers link against system libraries, so `cargo` alone is not enough. On Debian/Ubuntu:

```sh
sudo apt install \
  libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev \
  librsvg2-dev patchelf
```

Two of those are easy to miss because **nothing fails until the very last bundling step**, long after the app
itself has compiled and the `.deb` and `.rpm` have been produced:

- **`librsvg2-dev`** — the AppImage bundler runs `linuxdeploy-plugin-gtk`, which reads `librsvg-2.0.pc` via
  `pkg-config` to find the SVG loader. The runtime `librsvg2-2` package does **not** ship that `.pc` file. Without
  the `-dev` package the plugin aborts with:

  ```
  there is no 'libdir' variable for 'librsvg-2.0' library.
  ERROR: Failed to run plugin: gtk (exit code: 1)
  failed to bundle project: `failed to run linuxdeploy`
  ```

  which reads like a broken toolchain rather than a missing package.

- **`patchelf`** — linuxdeploy uses it to rewrite `RPATH` on every bundled `.so`.

If you only need to run or package for local use, `npm run tauri build --bundles deb` skips AppImage entirely.

## Scripts

| command | what it does |
| --- | --- |
| `npm run dev` | Vite dev server (port 5176). Pair with `npm run tauri dev`. |
| `npm run dev:prodweb` | Tauri dev shell against the **minified production** frontend (see below). |
| `npm run check` | typecheck → lint → test → build. What CI runs. |
| `npm run fix` | `eslint --fix` then Prettier. Run before pushing. |
| `npm run tauri build` | Full release bundle (deb + rpm + AppImage). |

### `dev:prodweb`

Runs the Rust side in dev (fast rebuilds, devtools) while the webview loads the production bundle from
`vite preview` on port 5179 instead of the dev server. That isolates how much of a performance problem is React
dev-mode overhead — double-render, dev warnings, HMR runtime — versus the real thing, a distinction `tauri dev`
alone cannot make and `tauri build` makes too slowly to iterate on.

It builds with `--mode benchmark` so `.env.benchmark` sets `VITE_ENABLE_BENCH=true`, keeping the
`/dev/markdown-bench` route in the bundle. `npm run build` (mode `production`) never includes it.

## Performance harness

Markdown/KaTeX rendering is the app's heaviest path. Three tools, deliberately measuring different layers:

- `node bench/pipeline-bench.mjs` — markdown → hast stage timings and **node counts**, with a regression ceiling.
  Node count is the headline number: every hast node becomes a React element *and* a DOM node, and every later
  style recalc walks all of them.
- `bench/index.html` — standalone, no framework. Open it in the **same engine Tauri embeds**, not Chrome:
  `/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/MiniBrowser apps/hermes-universal/bench/index.html`. Chromium numbers
  do not predict WebKitGTK. Variants A/B/C separate engine cost from React cost.
- `/dev/markdown-bench` — the real component tree over a LaTeX-heavy fixture, with commit time, node count and
  worst-frame during a sidebar toggle or width sweep.
