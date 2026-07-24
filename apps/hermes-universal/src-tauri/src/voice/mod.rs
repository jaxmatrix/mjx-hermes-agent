//! Rust-owned voice session (MJX-96).
//!
//! Rust is the single authority for the voice audio lifecycle — device, RMS
//! level, VAD, turn segmentation, pre-roll, encode *and* transcription — driven
//! by the explicit `VoiceMachine` state machine. React is reduced to "submit
//! transcript → speak → arm" and Rust emits **text, not audio** (the base64 clip
//! never crosses IPC).
//!
//! Module split mirrors the pure/impure boundary, which is also the test seam:
//!   * `vad` / `machine` — pure logic, no deps, unit-tested on every target;
//!   * `codec` — pure DSP/encoders, desktop-gated (rubato/hound/flacenc);
//!   * `capture` / `transcribe` / the commands below — the impure host that owns
//!     the cpal stream and the reqwest POST (added in phase 2).

// `allow(dead_code)`: the pure core lands in phase 1 but is not wired to the
// cpal host / commands until phase 2, so most of its surface is unreferenced in
// this intermediate commit. Remove these once `capture.rs` consumes them.
#[allow(dead_code)]
pub mod machine;
#[allow(dead_code)]
pub mod vad;

#[cfg(desktop)]
#[allow(dead_code)]
pub mod codec;
