//! The impure capture host: owns the cpal stream and runs the `VoiceMachine` as
//! an actor on the dedicated capture thread.
//!
//! cpal's `Stream` is `!Send`, so — as in the old `audio.rs` — the device is
//! opened, lives, and dies on ONE `std::thread`. Unlike `audio.rs` there is no
//! shared `Arc<Mutex<Vec<f32>>>`: the realtime callback downmixes to mono, takes
//! a block RMS, and sends both over one `mpsc` channel. That same channel
//! multiplexes commands (from the Tauri commands) and finalize replies (from the
//! transcribe task), so the machine advances single-threaded and lock-free and
//! stays a pure function. The thread is the SINGLE emitter: it applies the
//! machine's `VoiceEffect`s in order, so effect order is the wire order.
//!
//! The stream stays open for the whole conversation (`voice_open` … `voice_close`);
//! `Idle` means "open but discarding". No per-turn device open/close — that is
//! where the old start latency and races lived.

use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, SyncSender};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use tauri::{AppHandle, Emitter};

use crate::voice::codec::ToMonoF32;
use crate::voice::machine::{
    ArmMode, TurnOutcome, VoiceConfig, VoiceEffect, VoiceInput, VoiceMachine, VoiceStateKind,
};
use crate::voice::transcribe::{self, TranscribeCtx};

/// Maps f32 RMS onto the 0..1 scale the VAD thresholds are calibrated for. Ported
/// from `audio.rs::LEVEL_GAIN` (the old browser meter normalized 8-bit-centered
/// RMS by /42; the f32 equivalent is ~×(128/42) ≈ 3.0). Not load-bearing —
/// `speech_level` is a relative threshold on this same scale.
const LEVEL_GAIN: f32 = 3.0;

/// If the stream is playing but no frames arrive for this long, treat the device
/// as lost. cpal delivers input buffers continuously even in silence (~100 Hz),
/// so a gap this large means the device dropped (unplugged, default switched).
const STALL_MS: u128 = 1_000;

/// One command from the Tauri command layer to the running session.
pub enum VoiceCmd {
    Arm(ArmMode),
    Suspend,
    ForceTurn,
    Close,
}

/// Everything that reaches the actor loop over the one multiplexed channel.
pub enum VoiceMsg {
    /// One cpal callback's worth of mono frames (native rate) + that block's
    /// normalized RMS.
    Frames { mono: Vec<f32>, rms: f32 },
    Cmd(VoiceCmd),
    TurnFinished { turn_id: u64, outcome: TurnOutcome },
    StreamError(String),
}

/// Open the device and start the capture+machine actor. Returns the command
/// sender and the thread handle, or a synchronous error if the device could not
/// be opened (so `voice_open` can surface `no_input_device` etc. immediately).
pub fn open_session(
    app: AppHandle,
    id: String,
    cfg: VoiceConfig,
    ctx: TranscribeCtx,
) -> Result<(Sender<VoiceMsg>, JoinHandle<()>), String> {
    let (tx, rx) = std::sync::mpsc::channel::<VoiceMsg>();
    // Zero-capacity rendezvous so the caller learns the device-open result
    // synchronously (mirrors audio.rs).
    let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel::<Result<u32, String>>(0);

    let frames_tx = tx.clone();
    let reply_tx = tx.clone();
    let join = std::thread::Builder::new()
        .name("hermes-voice-capture".into())
        .spawn(move || capture_thread(app, id, cfg, ctx, rx, frames_tx, reply_tx, ready_tx))
        .map_err(|e| e.to_string())?;

    match ready_rx.recv() {
        Ok(Ok(_src_rate)) => Ok((tx, join)),
        Ok(Err(e)) => {
            let _ = join.join();
            Err(e)
        }
        Err(_) => {
            let _ = join.join();
            Err("capture_thread_died".into())
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn capture_thread(
    app: AppHandle,
    id: String,
    cfg: VoiceConfig,
    ctx: TranscribeCtx,
    rx: Receiver<VoiceMsg>,
    frames_tx: Sender<VoiceMsg>,
    reply_tx: Sender<VoiceMsg>,
    ready_tx: SyncSender<Result<u32, String>>,
) {
    // iOS needs its AVAudioSession put into a record category before capture; a
    // no-op elsewhere. See the function for the MJX-93 caveat.
    activate_audio_session();

    let host = cpal::default_host();
    let device = match host.default_input_device() {
        Some(d) => d,
        None => {
            let _ = ready_tx.send(Err("no_input_device".into()));
            return;
        }
    };
    let supported = match device.default_input_config() {
        Ok(c) => c,
        Err(e) => {
            let _ = ready_tx.send(Err(format!("no_input_config: {e}")));
            return;
        }
    };
    let src_rate = supported.sample_rate().0;
    let sample_format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();

    // The cpal error callback trips a stream-error message so the machine can
    // close cleanly with `device_lost`.
    let err_tx = frames_tx.clone();
    let err_fn = move |e: cpal::StreamError| {
        let _ = err_tx.send(VoiceMsg::StreamError(e.to_string()));
    };

    let built = match sample_format {
        cpal::SampleFormat::F32 => build_stream::<f32>(&device, &config, frames_tx.clone(), err_fn),
        cpal::SampleFormat::I16 => build_stream::<i16>(&device, &config, frames_tx.clone(), err_fn),
        cpal::SampleFormat::U16 => build_stream::<u16>(&device, &config, frames_tx.clone(), err_fn),
        cpal::SampleFormat::I32 => build_stream::<i32>(&device, &config, frames_tx.clone(), err_fn),
        cpal::SampleFormat::I8 => build_stream::<i8>(&device, &config, frames_tx.clone(), err_fn),
        cpal::SampleFormat::U8 => build_stream::<u8>(&device, &config, frames_tx.clone(), err_fn),
        other => {
            let _ = ready_tx.send(Err(format!("unsupported_sample_format: {other:?}")));
            return;
        }
    };
    let stream = match built {
        Ok(s) => s,
        Err(e) => {
            let _ = ready_tx.send(Err(format!("stream_build: {e}")));
            return;
        }
    };
    if let Err(e) = stream.play() {
        let _ = ready_tx.send(Err(format!("stream_play: {e}")));
        return;
    }
    let _ = ready_tx.send(Ok(src_rate));

    // The device is up; run the machine.
    let mut machine = VoiceMachine::new(cfg, src_rate);
    let mut effects: Vec<VoiceEffect> = Vec::new();
    machine.boot(&mut effects);
    if apply_effects(&app, &id, &ctx, &reply_tx, &mut effects) {
        drop(stream);
        return;
    }

    let mut last_frame_at = Instant::now();
    loop {
        let input = match rx.recv_timeout(Duration::from_millis(250)) {
            Ok(VoiceMsg::Frames { mono, rms }) => {
                last_frame_at = Instant::now();
                // `step` borrows `mono`; convert after the borrow ends is awkward,
                // so hold the Vec and pass a slice.
                effects.clear();
                machine.step(VoiceInput::Frames { mono: &mono, rms }, &mut effects);
                if apply_effects(&app, &id, &ctx, &reply_tx, &mut effects) {
                    break;
                }
                continue;
            }
            Ok(VoiceMsg::Cmd(cmd)) => match cmd {
                VoiceCmd::Arm(mode) => VoiceInput::Arm(mode),
                VoiceCmd::Suspend => VoiceInput::Suspend,
                VoiceCmd::ForceTurn => VoiceInput::ForceTurn,
                VoiceCmd::Close => VoiceInput::Close,
            },
            Ok(VoiceMsg::TurnFinished { turn_id, outcome }) => {
                VoiceInput::TurnFinished { turn_id, outcome }
            }
            Ok(VoiceMsg::StreamError(e)) => VoiceInput::StreamError(e),
            Err(RecvTimeoutError::Timeout) => {
                // Device stall watchdog: the stream is playing but no frames.
                if matches!(machine.kind(), VoiceStateKind::Closed | VoiceStateKind::Closing) {
                    break;
                }
                if last_frame_at.elapsed().as_millis() >= STALL_MS {
                    VoiceInput::StreamError("no_audio_frames".into())
                } else {
                    continue;
                }
            }
            Err(RecvTimeoutError::Disconnected) => break,
        };

        effects.clear();
        machine.step(input, &mut effects);
        if apply_effects(&app, &id, &ctx, &reply_tx, &mut effects) {
            break;
        }
    }

    drop(stream); // no more callbacks after this returns
}

/// Apply the machine's effects on the capture thread — the single emitter.
/// Returns `true` when a `Shutdown` effect was seen (the loop should exit).
fn apply_effects(
    app: &AppHandle,
    id: &str,
    ctx: &TranscribeCtx,
    reply_tx: &Sender<VoiceMsg>,
    effects: &mut Vec<VoiceEffect>,
) -> bool {
    let mut shutdown = false;
    for eff in effects.drain(..) {
        match eff {
            VoiceEffect::Emit(topic, payload) => {
                let _ = app.emit(&format!("voice://{id}/{topic}"), payload);
            }
            VoiceEffect::Finalize(job) => {
                transcribe::spawn_finalize(ctx, job, reply_tx.clone());
            }
            VoiceEffect::Shutdown => shutdown = true,
        }
    }
    shutdown
}

/// Build a typed cpal input stream: convert each sample to f32, downmix the
/// interleaved channels to mono, take the block RMS, and send one
/// `VoiceMsg::Frames` per callback. Runs on cpal's REALTIME thread, so it does
/// only arithmetic and a non-blocking channel send — the machine step + IPC emit
/// happen on the capture thread.
fn build_stream<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    frames_tx: Sender<VoiceMsg>,
    err_fn: impl FnMut(cpal::StreamError) + Send + 'static,
) -> Result<cpal::Stream, cpal::BuildStreamError>
where
    T: cpal::SizedSample + ToMonoF32 + Send + 'static,
{
    let channels = config.channels.max(1) as usize;
    device.build_input_stream(
        config,
        move |data: &[T], _: &cpal::InputCallbackInfo| {
            let mut mono = Vec::with_capacity(data.len() / channels + 1);
            let mut acc_sq = 0.0f64;
            for frame in data.chunks(channels) {
                let mut sum = 0.0f32;
                for &s in frame {
                    sum += s.to_f32();
                }
                let m = sum / channels as f32;
                mono.push(m);
                acc_sq += (m as f64) * (m as f64);
            }
            let rms = if mono.is_empty() {
                0.0
            } else {
                (acc_sq / mono.len() as f64).sqrt() as f32 * LEVEL_GAIN
            };
            let _ = frames_tx.send(VoiceMsg::Frames { mono, rms: rms.min(1.0) });
        },
        err_fn,
        None,
    )
}

/// Put the OS audio session into a record-capable state before capture.
///
/// Only iOS needs this (its `AVAudioSession` defaults to a playback-only category
/// that yields no input). Desktop/Android are no-ops. NOTE: the iOS activation is
/// not yet wired — it needs an objc bridge and can only be built/verified on a Mac
/// (MJX-93). Left as a documented hook so the capture path is otherwise complete.
#[cfg(target_os = "ios")]
fn activate_audio_session() {
    // TODO(MJX-93): AVAudioSession.setCategory(.record) + setActive(true) via an
    // objc2 bridge, plus interruption handling (a call must map to StreamError →
    // device_lost). Until then iOS capture will not receive input.
    log::warn!("voice: iOS AVAudioSession activation not yet implemented (MJX-93)");
}

#[cfg(not(target_os = "ios"))]
fn activate_audio_session() {}
