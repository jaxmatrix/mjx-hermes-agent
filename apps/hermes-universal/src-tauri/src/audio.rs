//! Native microphone capture + encode (voice/dictation, MJX-88).
//!
//! Why this exists: on Linux the Tauri webview is WebKitGTK, whose `MediaRecorder`
//! only supports `audio/mp4` (AAC) and — even with the system `avenc_aac` encoder
//! present — yields an EMPTY audio blob, so transcription silently never starts.
//! The root problem is a dependency on the host's system media stack (GStreamer/
//! libav), which is fragile and un-bundleable. So we bypass the webview entirely:
//! capture raw PCM natively with `cpal` and encode with pure-Rust codecs (`hound`
//! WAV / `flacenc` FLAC) compiled into the app — no system codec, no C toolchain.
//!
//! Wire path (mirrors `pty.rs`/`transport.rs`): the client picks an `id`, subscribes
//! to `audio://{id}/level` (throttled 0..1 RMS for the meter/VAD) BEFORE calling
//! `audio_start_recording`, then `audio_stop_recording` returns the encoded clip
//! bytes which the frontend wraps as a Blob and feeds the existing
//! `transcribeAudio(dataUrl, mimeType)` path. VAD/silence detection stays in JS,
//! fed by the level stream (same as the old AnalyserNode meter).
//!
//! Phase A is desktop-only (Linux/macOS/Windows). Mobile keeps the working webview
//! MediaRecorder until Phase B flips it to cpal's `oboe`/CoreAudio backend; the
//! commands still exist on mobile as `unsupported_platform` stubs so a stray call
//! is a clean error, not a panic. cpal is `!Send` on every backend, so its `Stream`
//! is born, lives, and dies on one dedicated `std::thread` — only `Send` handles
//! (`AppHandle`, `Arc<AtomicBool>`, `Arc<Mutex<Vec<f32>>>`) cross the boundary.

use serde::Serialize;

/// Encoded clip returned to the frontend. `base64` is a full container (WAV/FLAC),
/// base64-encoded; JS decodes it into a Blob tagged `mimeType`. Base64 rather than
/// `Vec<u8>` because Tauri serializes byte vectors as JSON number arrays (~4x bloat).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AudioClip {
    pub base64: String,
    pub mime_type: String,
    pub duration_ms: u64,
    pub sample_rate: u32,
}

// --------------------------------------------------------------------------
// Desktop: real implementation.
// --------------------------------------------------------------------------
#[cfg(desktop)]
mod imp {
    use super::AudioClip;
    use std::io::Cursor;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc::sync_channel;
    use std::sync::{Arc, Mutex};
    use std::time::Instant;

    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use tauri::{AppHandle, Emitter};

    /// Emit a normalized RMS level no more often than this (≈16 Hz) so the meter
    /// events don't flood IPC — cpal fires its callback every audio buffer (~100 Hz
    /// at 48 kHz/480-frame buffers), far more than a meter or the JS silence timer
    /// needs. The recorded PCM is always fully buffered regardless of this throttle.
    const LEVEL_EMIT_MS: u128 = 60;

    /// Maps f32 [-1,1] RMS onto the 0..1 scale the JS VAD expects. The old browser
    /// meter normalized 8-bit-centered RMS by /42 (use-mic-recorder.ts); the f32
    /// equivalent is ~×(128/42) ≈ 3.0. Not load-bearing — `silenceLevel` is a
    /// relative threshold on this same scale.
    const LEVEL_GAIN: f32 = 3.0;

    /// Handle to the one live capture. The cpal `Stream` is NOT here (it is `!Send`
    /// and lives only inside the capture thread); we keep the levers to stop it and
    /// reclaim the recorded PCM.
    struct RecordingSession {
        id: String,
        /// Cleared (false) to ask the capture thread to drop its Stream and finish.
        stop_flag: Arc<AtomicBool>,
        join: std::thread::JoinHandle<CaptureResult>,
        started_at: Instant,
    }

    /// What the capture thread returns once its Stream is dropped: mono f32 at the
    /// device's native rate, plus any error seen on cpal's error callback.
    struct CaptureResult {
        pcm_mono: Vec<f32>,
        src_rate: u32,
        error: Option<String>,
    }

    impl CaptureResult {
        fn empty() -> Self {
            CaptureResult {
                pcm_mono: Vec::new(),
                src_rate: 0,
                error: None,
            }
        }
    }

    /// Field stays private: `RecordingSession` is module-internal, and only
    /// `start`/`take_and_stop` below ever touch it. lib.rs just `.manage()`s it.
    #[derive(Default)]
    pub struct AudioState(Mutex<Option<RecordingSession>>);

    /// Cheap, dependency-free sample→f32 conversion so we don't rely on cpal's
    /// sample-conversion trait surface. Covers the formats devices actually capture.
    trait ToMonoF32: Copy {
        fn to_f32(self) -> f32;
    }
    impl ToMonoF32 for f32 {
        fn to_f32(self) -> f32 {
            self
        }
    }
    impl ToMonoF32 for i16 {
        fn to_f32(self) -> f32 {
            self as f32 / 32768.0
        }
    }
    impl ToMonoF32 for u16 {
        fn to_f32(self) -> f32 {
            (self as f32 - 32768.0) / 32768.0
        }
    }
    impl ToMonoF32 for i32 {
        fn to_f32(self) -> f32 {
            self as f32 / 2_147_483_648.0
        }
    }
    impl ToMonoF32 for i8 {
        fn to_f32(self) -> f32 {
            self as f32 / 128.0
        }
    }
    impl ToMonoF32 for u8 {
        fn to_f32(self) -> f32 {
            (self as f32 - 128.0) / 128.0
        }
    }

    /// Build a typed cpal input stream: convert each sample to f32, downmix the
    /// interleaved channels to mono (keeps the shared buffer at 1/N size), append to
    /// `buf`, and hand a throttled RMS level to `level_tx`. All state the closure
    /// needs is captured by move; the closure is `FnMut` so it holds the throttle
    /// accumulators inline.
    ///
    /// This runs on cpal's REALTIME audio thread, so it must not block: it only does
    /// arithmetic, a short buffer append, and a non-blocking channel send. The actual
    /// `emit` (serialize + hand off to the webview) happens on the capture thread —
    /// doing IPC here would risk xruns/dropouts.
    fn build_stream<T>(
        device: &cpal::Device,
        config: &cpal::StreamConfig,
        buf: Arc<Mutex<Vec<f32>>>,
        level_tx: std::sync::mpsc::Sender<f32>,
        err_fn: impl FnMut(cpal::StreamError) + Send + 'static,
    ) -> Result<cpal::Stream, cpal::BuildStreamError>
    where
        T: cpal::SizedSample + ToMonoF32 + Send + 'static,
    {
        let channels = config.channels.max(1) as usize;

        // Throttle state, owned by the FnMut callback.
        let mut acc_sq: f64 = 0.0;
        let mut acc_n: usize = 0;
        let mut last_emit = Instant::now();

        device.build_input_stream(
            config,
            move |data: &[T], _: &cpal::InputCallbackInfo| {
                let mut local = Vec::with_capacity(data.len() / channels + 1);
                for frame in data.chunks(channels) {
                    let mut sum = 0.0f32;
                    for &s in frame {
                        sum += s.to_f32();
                    }
                    let mono = sum / channels as f32;
                    local.push(mono);
                    acc_sq += (mono as f64) * (mono as f64);
                    acc_n += 1;
                }

                if let Ok(mut guard) = buf.lock() {
                    guard.extend_from_slice(&local);
                }

                if acc_n > 0 && last_emit.elapsed().as_millis() >= LEVEL_EMIT_MS {
                    let rms = (acc_sq / acc_n as f64).sqrt() as f32;
                    let normalized = (rms * LEVEL_GAIN).min(1.0);
                    let _ = level_tx.send(normalized);
                    acc_sq = 0.0;
                    acc_n = 0;
                    last_emit = Instant::now();
                }
            },
            err_fn,
            None,
        )
    }

    /// Runs on the dedicated capture thread. Opens the default input device, builds
    /// and plays the stream, reports open success/failure back through `ready_tx`
    /// (so `start` can surface a synchronous error), then holds the Stream alive
    /// until `stop_flag` clears and returns the buffered PCM.
    fn capture_thread(
        app: AppHandle,
        id: String,
        stop_flag: Arc<AtomicBool>,
        ready_tx: std::sync::mpsc::SyncSender<Result<(), String>>,
    ) -> CaptureResult {
        let host = cpal::default_host();
        let device = match host.default_input_device() {
            Some(d) => d,
            None => {
                let _ = ready_tx.send(Err("no_input_device".into()));
                return CaptureResult::empty();
            }
        };
        let supported = match device.default_input_config() {
            Ok(c) => c,
            Err(e) => {
                let _ = ready_tx.send(Err(format!("no_input_config: {e}")));
                return CaptureResult::empty();
            }
        };
        let src_rate = supported.sample_rate().0;
        let sample_format = supported.sample_format();
        let config: cpal::StreamConfig = supported.into();

        let buf: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));
        let err_slot: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

        // Device disconnect / xrun etc.: record the message and trip the stop flag so
        // the park loop exits and `stop` returns whatever we captured (partial clip
        // beats nothing). Mirrors the JS `recorder.onerror` path.
        let err_store = err_slot.clone();
        let err_flag = stop_flag.clone();
        let err_fn = move |e: cpal::StreamError| {
            if let Ok(mut slot) = err_store.lock() {
                *slot = Some(e.to_string());
            }
            err_flag.store(false, Ordering::SeqCst);
        };

        // Levels leave the realtime audio callback over this channel; this thread
        // does the actual IPC emit (see build_stream).
        let (level_tx, level_rx) = std::sync::mpsc::channel::<f32>();

        let built = match sample_format {
            cpal::SampleFormat::F32 => {
                build_stream::<f32>(&device, &config, buf.clone(), level_tx, err_fn)
            }
            cpal::SampleFormat::I16 => {
                build_stream::<i16>(&device, &config, buf.clone(), level_tx, err_fn)
            }
            cpal::SampleFormat::U16 => {
                build_stream::<u16>(&device, &config, buf.clone(), level_tx, err_fn)
            }
            cpal::SampleFormat::I32 => {
                build_stream::<i32>(&device, &config, buf.clone(), level_tx, err_fn)
            }
            cpal::SampleFormat::I8 => {
                build_stream::<i8>(&device, &config, buf.clone(), level_tx, err_fn)
            }
            cpal::SampleFormat::U8 => {
                build_stream::<u8>(&device, &config, buf.clone(), level_tx, err_fn)
            }
            other => {
                let _ = ready_tx.send(Err(format!("unsupported_sample_format: {other:?}")));
                return CaptureResult::empty();
            }
        };
        let stream = match built {
            Ok(s) => s,
            Err(e) => {
                let _ = ready_tx.send(Err(format!("stream_build: {e}")));
                return CaptureResult::empty();
            }
        };
        if let Err(e) = stream.play() {
            let _ = ready_tx.send(Err(format!("stream_play: {e}")));
            return CaptureResult::empty();
        }
        let _ = ready_tx.send(Ok(()));

        // Keep the (!Send) Stream alive on THIS thread until asked to stop, forwarding
        // levels to the webview as they arrive. The 50 ms timeout bounds how long a
        // stop request waits, and doubles as the poll for `stop_flag`.
        let level_topic = format!("audio://{id}/level");
        while stop_flag.load(Ordering::SeqCst) {
            match level_rx.recv_timeout(std::time::Duration::from_millis(50)) {
                Ok(level) => {
                    let _ = app.emit(&level_topic, level);
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                // Sender lives in the stream callback; disconnect means capture ended.
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        drop(stream); // no more callback invocations after this returns

        let pcm_mono = buf.lock().map(|mut g| std::mem::take(&mut *g)).unwrap_or_default();
        let error = err_slot.lock().ok().and_then(|mut g| g.take());
        CaptureResult {
            pcm_mono,
            src_rate,
            error,
        }
    }

    pub fn start(app: AppHandle, state: &AudioState, id: String) -> Result<(), String> {
        let mut guard = state.0.lock().map_err(|_| "audio_state_poisoned")?;
        if guard.is_some() {
            return Err("already_recording".into());
        }

        let stop_flag = Arc::new(AtomicBool::new(true)); // true = keep going
        // Rendezvous so `start` returns the stream-open result synchronously.
        let (ready_tx, ready_rx) = sync_channel::<Result<(), String>>(0);

        let flag = stop_flag.clone();
        let app_cb = app.clone();
        let id_cb = id.clone();
        let join = std::thread::Builder::new()
            .name("hermes-audio-capture".into())
            .spawn(move || capture_thread(app_cb, id_cb, flag, ready_tx))
            .map_err(|e| e.to_string())?;

        match ready_rx.recv() {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                let _ = join.join();
                return Err(e);
            }
            Err(_) => {
                let _ = join.join();
                return Err("capture_thread_died".into());
            }
        }

        *guard = Some(RecordingSession {
            id,
            stop_flag,
            join,
            started_at: Instant::now(),
        });
        Ok(())
    }

    /// Take the live session out of state and stop its thread, returning the joined
    /// result. `expected_id` guards against a stale id (a newer session replaced it).
    fn take_and_stop(
        state: &AudioState,
        expected_id: &str,
    ) -> Result<(CaptureResult, u64), String> {
        let session = {
            let mut g = state.0.lock().map_err(|_| "audio_state_poisoned")?;
            match g.take() {
                Some(s) if s.id == expected_id => s,
                Some(other) => {
                    *g = Some(other);
                    return Err("id_mismatch".into());
                }
                None => return Err("not_recording".into()),
            }
        };
        let duration_ms = session.started_at.elapsed().as_millis() as u64;
        // The capture thread notices this within its 50 ms level-poll timeout, drops
        // the cpal Stream, and returns the buffered PCM.
        session.stop_flag.store(false, Ordering::SeqCst);
        let cap = session.join.join().map_err(|_| "capture_thread_panicked")?;
        Ok((cap, duration_ms))
    }

    pub fn stop(state: &AudioState, id: String, format: Option<String>) -> Result<AudioClip, String> {
        let (cap, duration_ms) = take_and_stop(state, &id)?;

        // Surface a capture error only if it cost us the whole clip; a partial clip
        // after a mid-record error is still usable.
        if cap.pcm_mono.is_empty() {
            if let Some(e) = cap.error {
                return Err(e);
            }
            return Err("empty_recording".into());
        }

        let src_rate = cap.src_rate;
        let mono16k = resample_to_16k(&cap.pcm_mono, src_rate)?;
        let format = format.unwrap_or_else(|| "wav".into());
        let (bytes, mime_type) = encode(&mono16k, &format)?;
        let base64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes);
        Ok(AudioClip {
            base64,
            mime_type,
            duration_ms,
            sample_rate: 16_000,
        })
    }

    pub fn cancel(state: &AudioState, id: String) -> Result<(), String> {
        // Stop + discard; ignore "not_recording"/"id_mismatch" so cancel is idempotent.
        let _ = take_and_stop(state, &id);
        Ok(())
    }

    /// Anti-aliased resample of mono f32 to 16 kHz via rubato (pure Rust). Passthrough
    /// when already 16 kHz. 16 kHz mono matches whisper's expected input and keeps the
    /// base64 payload small over a remote gateway.
    fn resample_to_16k(input: &[f32], src_rate: u32) -> Result<Vec<f32>, String> {
        use rubato::{FftFixedIn, Resampler};

        const TARGET: usize = 16_000;
        if input.is_empty() || src_rate as usize == TARGET {
            return Ok(input.to_vec());
        }

        let mut resampler = FftFixedIn::<f32>::new(src_rate as usize, TARGET, 1024, 2, 1)
            .map_err(|e| format!("resampler_init: {e}"))?;
        let mut out: Vec<f32> = Vec::with_capacity(input.len() * TARGET / src_rate as usize + 1024);
        let mut rest = input;

        loop {
            let needed = resampler.input_frames_next();
            if rest.len() >= needed {
                let (chunk, tail) = rest.split_at(needed);
                let res = resampler
                    .process(&[chunk], None)
                    .map_err(|e| format!("resample: {e}"))?;
                out.extend_from_slice(&res[0]);
                rest = tail;
            } else {
                // Final short chunk: `process_partial` zero-pads internally.
                let res = resampler
                    .process_partial(Some(&[rest]), None)
                    .map_err(|e| format!("resample_partial: {e}"))?;
                out.extend_from_slice(&res[0]);
                break;
            }
        }
        Ok(out)
    }

    fn f32_to_i16(x: f32) -> i16 {
        (x.clamp(-1.0, 1.0) * 32767.0).round() as i16
    }

    /// Encode mono 16 kHz f32 to an in-memory container the gateway accepts.
    fn encode(samples: &[f32], format: &str) -> Result<(Vec<u8>, String), String> {
        match format {
            "flac" => encode_flac(samples),
            "wav" => encode_wav(samples),
            other => Err(format!("unsupported_format: {other}")),
        }
    }

    fn encode_wav(samples: &[f32]) -> Result<(Vec<u8>, String), String> {
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 16_000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut cursor = Cursor::new(Vec::<u8>::new());
        {
            let mut writer =
                hound::WavWriter::new(&mut cursor, spec).map_err(|e| format!("wav_init: {e}"))?;
            for &s in samples {
                writer
                    .write_sample(f32_to_i16(s))
                    .map_err(|e| format!("wav_write: {e}"))?;
            }
            writer.finalize().map_err(|e| format!("wav_finalize: {e}"))?;
        }
        Ok((cursor.into_inner(), "audio/wav".into()))
    }

    fn encode_flac(samples: &[f32]) -> Result<(Vec<u8>, String), String> {
        use flacenc::component::BitRepr;
        use flacenc::error::Verify;

        let config = flacenc::config::Encoder::default()
            .into_verified()
            .map_err(|(_, e)| format!("flac_config: {e:?}"))?;
        let pcm_i32: Vec<i32> = samples.iter().map(|&s| f32_to_i16(s) as i32).collect();
        let source = flacenc::source::MemSource::from_samples(&pcm_i32, 1, 16, 16_000);
        let stream = flacenc::encode_with_fixed_block_size(&config, source, config.block_size)
            .map_err(|e| format!("flac_encode: {e:?}"))?;
        let mut sink = flacenc::bitsink::ByteSink::new();
        stream
            .write(&mut sink)
            .map_err(|e| format!("flac_write: {e:?}"))?;
        Ok((sink.as_slice().to_vec(), "audio/flac".into()))
    }
}

#[cfg(desktop)]
pub use imp::AudioState;

#[cfg(desktop)]
#[tauri::command]
pub async fn audio_start_recording(
    app: tauri::AppHandle,
    state: tauri::State<'_, imp::AudioState>,
    id: String,
) -> Result<(), String> {
    imp::start(app, &state, id)
}

#[cfg(desktop)]
#[tauri::command]
pub async fn audio_stop_recording(
    state: tauri::State<'_, imp::AudioState>,
    id: String,
    format: Option<String>,
) -> Result<AudioClip, String> {
    // Runs inline rather than on a blocking pool: `unpark` wakes the capture thread
    // immediately so the join returns promptly, and resample+encode of a dictation-
    // length clip is milliseconds. (Same shape as pty.rs's blocking work in an async
    // command.) Keeping it inline avoids smuggling a `State` reference across a
    // `spawn_blocking` boundary.
    imp::stop(&state, id, format)
}

#[cfg(desktop)]
#[tauri::command]
pub async fn audio_cancel_recording(
    state: tauri::State<'_, imp::AudioState>,
    id: String,
) -> Result<(), String> {
    imp::cancel(&state, id)
}

// --------------------------------------------------------------------------
// Mobile: Phase A keeps the working webview MediaRecorder. Commands exist so a
// stray invoke returns a clear error, not a panic. Phase B swaps in cpal (oboe/
// CoreAudio) here.
// --------------------------------------------------------------------------
#[cfg(mobile)]
#[derive(Default)]
pub struct AudioState;

#[cfg(mobile)]
#[tauri::command]
pub async fn audio_start_recording(
    _state: tauri::State<'_, AudioState>,
    _id: String,
) -> Result<(), String> {
    Err("unsupported_platform".to_string())
}

#[cfg(mobile)]
#[tauri::command]
pub async fn audio_stop_recording(
    _state: tauri::State<'_, AudioState>,
    _id: String,
    _format: Option<String>,
) -> Result<AudioClip, String> {
    Err("unsupported_platform".to_string())
}

#[cfg(mobile)]
#[tauri::command]
pub async fn audio_cancel_recording(
    _state: tauri::State<'_, AudioState>,
    _id: String,
) -> Result<(), String> {
    Err("unsupported_platform".to_string())
}
