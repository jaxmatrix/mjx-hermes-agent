# Voice (MJX-88) — Handoff

Branch: `jaishukla7768/mjx-88-fix-mic-permission-issue` · PR: **#28**
(jaxmatrix/mjx-hermes-agent → main)

Goal: get the voice conversation + dictation features working across Android, iOS, and
desktop from the Tauri `apps/hermes-universal` app. The JS voice pipeline was already fully
built and is byte-identical to the working `apps/desktop` (Electron) app — every problem here
was **native/runtime**, not wiring.

---

## Current status

| Platform | State |
|---|---|
| **Android** | ✅ Voice works (mic permission + capture + transcribe + send). |
| **iOS** | 🟡 Code prepared, not built. Needs a Mac + `tauri ios init`. Tracked in **MJX-93**. |
| **macOS** | 🟡 Code prepared, not verified. Needs a Mac. Tracked in **MJX-94**. |
| **Linux desktop** | 🟡 **Rewritten to native Rust capture** (see "Native recorder" below). Code compiles + typechecks; **on-device E2E not yet run** (needs `libasound2-dev` to build). |

---

## What was fixed (committed on the branch)

### 1. Native mic permission — `tauri-plugin-mic` (commit `ef925429b`)
New in-tree permission-only plugin at `src-tauri/plugins/tauri-plugin-mic/` (modeled on the
vendored `tauri-plugin-keyring`). Audio **capture stays in the webview** (`getUserMedia`); the
plugin only owns the OS permission layer, from committed locations (since `src-tauri/gen/` is
gitignored/ephemeral):
- **Android**: plugin `AndroidManifest.xml` declares `RECORD_AUDIO` + `MODIFY_AUDIO_SETTINGS`
  (Gradle merges into the app manifest). Kotlin `MicPlugin` is just
  `@TauriPlugin(permissions=[Permission(strings=["android.permission.RECORD_AUDIO"], alias="microphone")])`
  — Tauri's base `Plugin` supplies `checkPermissions`/`requestPermissions`.
- **iOS**: Swift `AVAudioSession` check/request + committed `src-tauri/Info.ios.plist`
  (`NSMicrophoneUsageDescription`).
- **Desktop**: no-op `Granted`; `src-tauri/Info.plist` covers macOS/WKWebView.
- **JS seam** `src/lib/mic-permission.ts` → `ensureMicPermission()` pre-flights on mobile
  (fail-open on desktop), wired into `use-mic-recorder.ts` before `getUserMedia`.
- Wiring: `src-tauri/Cargo.toml` (path dep), `src-tauri/src/lib.rs` (`.plugin(tauri_plugin_mic::init())`),
  `src-tauri/capabilities/default.json` (`mic:allow-check-permission`, `mic:allow-request-permission`).

### 2. WebKitGTK `getUserMedia` auto-deny (commit `9e865410c`)
On Linux the webview is WebKitGTK, which **auto-denies `getUserMedia`** unless the embedder
answers the WebView's `permission-request` signal — wry doesn't, so the mic failed instantly
with no prompt. Fix in `src-tauri/src/lib.rs` `setup()`, Linux only:
`window.with_webview(|w| w.inner().connect_permission_request(...))` → `.allow()` for
`UserMediaPermissionRequest`. Adds a Linux-only `webkit2gtk = "2.0"` dep (matches wry's 2.0.2)
with feature `v2_8`. Linux has no per-app OS mic dialog, so allowing the WebKit request is
enough. **This made recording start on Linux.**

### 3. MediaRecorder timeslice (commit `6118bdbdb`)
`use-mic-recorder.ts`: `recorder.start(250)` + `recorder.requestData()` before `stop()` so
WebKitGTK flushes audio chunks during recording instead of a single stop-time flush. Necessary
but **not sufficient** (see open problem).

---

## Native recorder (current direction — supersedes the JS-WAV plan below)

Rather than work around WebKitGTK's `MediaRecorder`, **capture moved into Rust**. Decision:
audio becomes a single backend-owned pipeline so future work (streaming transcription, native
VAD, on-device STT, denoise) lives in one place and reaches every platform; the cost is a
higher contributor/build bar, mitigated by using **pure-Rust codecs only** (no C toolchain).

**Pipeline:** `cpal` capture → downmix mono → `rubato` resample 16 kHz → `hound` WAV (default)
or `flacenc` FLAC → base64 → existing `transcribeAudio(dataUrl, mimeType)`. No system
GStreamer/libav, so no `apt install` of codecs and nothing to break per-host.

- **Rust** `src-tauri/src/audio.rs` — `audio_start_recording` / `audio_stop_recording` /
  `audio_cancel_recording` + `AudioState`, wired in `lib.rs` (`mod`, `use`, `.manage`,
  `generate_handler!`). cpal's `Stream` is `!Send`, so it is born/lives/dies on one dedicated
  `std::thread`; a `sync_channel(0)` rendezvous lets `start` return `no_input_device` etc.
  synchronously. Levels leave the **realtime audio callback** over an `mpsc` channel and the
  capture thread does the `emit` — doing IPC in the callback risks xruns.
- **Events:** `audio://{id}/level` (normalized 0..1 RMS, throttled ~16/s), per-uuid, mirroring
  the `pty://`/`ws://` convention. Subscribe BEFORE invoking start.
- **Frontend:** `use-native-mic-recorder.ts` (new, drop-in), `use-web-mic-recorder.ts` (the old
  MediaRecorder path, kept as fallback), `mic-recorder-types.ts` (shared contract), and
  `use-mic-recorder.ts` is now a dispatcher — desktop → native, falling back to web; mobile
  stays on MediaRecorder. Both hooks are always called so hook order is stable. The VAD/silence
  logic is ported verbatim and just consumes Rust levels, so `silenceLevel`/`silenceMs`/
  `idleSilenceMs`/`onSilence` are unchanged.
- **Silent-failure fix:** an empty/failed capture now routes through `options.onError` →
  `notifyError` toast instead of resolving `null` with no feedback (the reason this bug hid for
  so long).

### ⚠️ New build dependency (Linux)

`cpal`'s ALSA backend needs **`libasound2-dev`** at BUILD time (`alsa.pc` + headers):

```
sudo apt install -y libasound2-dev      # Fedora: alsa-lib-devel
```

Add this to CI and any Linux dev machine. The **runtime** lib (`libasound.so.2`) ships in
`libasound2t64`/`libasound2` and is present on essentially every desktop Linux;
`tauri.conf.json` now declares `bundle.linux.deb.depends: ["libasound2"]`
(`libasound2t64` declares `Provides: libasound2`, so it resolves on old and new Ubuntu).
macOS (CoreAudio) and Windows (WASAPI) need nothing extra.

**Status:** `cargo check` clean, `tsc --noEmit` clean, 573 vitest tests green. The
resampler/encoder APIs were validated by compiling and running them standalone (rubato
48k→16k, valid `RIFF` and `fLaC` output). **Not yet verified end-to-end on a real mic.**

**Phase B (not started):** move Android/iOS onto the native path too — cpal `oboe`/NDK wiring
on Android, `AVAudioSession` record category on iOS — then drop the MediaRecorder fallback and
the dead duplicate `src/app/chat/use-voice-recorder.ts`.

---

## Open problem — Linux transcription still not starting 🔴 (HISTORICAL — fixed by the above)

Even after all three fixes **and** installing the AAC encoder, Linux voice does not transcribe.

**What we know (verified):**
- WebKitGTK 2.52 `MediaRecorder.isTypeSupported` returns **`audio/mp4` = true, and `false` for
  webm / webm+opus / ogg / ogg+opus / wav.** So on Linux the app can only record `audio/mp4` (AAC).
  (Verified with a headless PyGObject WebKit2 probe — see "Debugging tools".)
- `audio/mp4` needs the libav AAC encoder `avenc_aac`, which was **missing**. Installing
  `gstreamer1.0-libav` added it (`avenc_aac ! mp4mux` now produces bytes standalone).
- **BUT after installing it, voice still does not work** — the transcribe step never starts,
  i.e. the blob is still empty. So WebKitGTK's `MediaRecorder(audio/mp4)` is still not producing
  usable audio in the real app.

**Recommended next step (the real fix):**
Stop depending on WebKitGTK's `MediaRecorder` on Linux entirely. Capture **raw PCM via Web Audio**
(an `AudioWorklet`, or `ScriptProcessorNode` as a fallback) and **encode a WAV blob in JS**. This:
- has **no GStreamer/codec dependency** (works on any WebKitGTK, no `apt install` needed),
- produces `audio/wav`, which the gateway already accepts (`web_server.py` `_AUDIO_MIME_EXTENSIONS`
  maps `audio/wav → .wav`, and the STT decodes wav),
- reuses the mic stream the app already has (the `AnalyserNode` VAD meter already reads that same
  PCM — proof the audio graph works on WebKitGTK even when MediaRecorder doesn't).

Scope: branch the capture path in `use-mic-recorder.ts` — on WebKitGTK (or universally) use the
Web Audio → WAV recorder; keep `MediaRecorder` for mobile (works there). **Also add an error toast
when a recording comes back 0 bytes**, so it never fails silently again (the whole bug was invisible
because an empty blob makes `handle.stop()` resolve `null` and the hooks return with no toast).

Backend reference: `hermes_cli/web_server.py:4149` `POST /api/audio/transcribe` (rejects empty
audio with HTTP 400; suffix from `_audio_extension_for_mime`, `web_server.py:1287`).

---

## Debugging tools set up (dev-only)

- **WebKitGTK remote inspector**: `src-tauri/src/main.rs` sets `WEBKIT_INSPECTOR_SERVER=127.0.0.1:2222`
  (+ `WEBKIT_DISABLE_COMPOSITING_MODE=1`) in debug/Linux builds. Open `http://127.0.0.1:2222` in
  **GNOME Web (Epiphany)** — **not Chrome** (Chrome renders the target list but the "Inspect"
  button doesn't work; WebKit's inspector isn't CDP). *These `main.rs` lines are dev conveniences —
  strip them before merge if undesired.*
- **Zed debugging** (`.zed/debug.json` + `.zed/tasks.json`, gitignored): CodeLLDB Launch/Attach for
  the Rust side (Launch avoids the `ptrace_scope` issue); a Chrome-CDP config for frontend logic
  (Chrome only — **cannot** attach to the WebKitGTK webview on Linux; no CDP there).
- **Isolated WebKitGTK probe** (how the `isTypeSupported` facts above were obtained): a headless
  PyGObject `WebKit2 4.1` WebView that loads a test page and reports back via a script-message
  handler. `MiniBrowser` would **not** load pages from the agent shell; the PyGObject approach is
  the reliable way to test the exact engine. (Throwaway script lived in the session scratchpad.)

---

## Key WebKitGTK gotchas discovered (Linux desktop)

1. `getUserMedia` is auto-denied unless you handle the WebView `permission-request` signal (fixed).
2. `MediaRecorder` only supports **`audio/mp4` (AAC)** — not webm/opus/ogg/wav; and even with
   `avenc_aac` present it still failed to produce usable audio in the app (unresolved → use WAV).
3. The Web Inspector is slow and Chrome can't drive it (no CDP) — use Epiphany, or instrument.

---

## Follow-up tasks / verification

- **Linear MJX-93** — iOS: `tauri ios init` on a Mac, build, verify `AVAudioSession` + Info.ios.plist
  merge; validate wry's WKWebView `requestMediaCapturePermissionFor` (getUserMedia) works.
- **Linear MJX-94** — macOS: verify `Info.plist` `NSMicrophoneUsageDescription` merge + TCC prompt.
- **Android** — confirm the plugin `<uses-permission>` merged into the app manifest on-device
  (grep the merged manifest under `gen/android/app/build/intermediates/merged_manifests/**` for
  `RECORD_AUDIO`).
- **Linux** — implement the Web Audio → WAV capture fallback (the fix for the open problem).

Green today: `cargo check` (plugin + app), `tsc --noEmit`, 573 vitest tests.
