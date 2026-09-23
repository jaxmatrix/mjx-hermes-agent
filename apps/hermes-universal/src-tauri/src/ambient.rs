//! Cross-window ambient cue arbiter — Electron `event-dedupe.ts`
//! (`hermes:ambient:claim`). First claim within the TTL wins; peers stay quiet.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::State;

const DEDUPE_INTERVAL_MS: u64 = 1000;
const SPEECH_CLAIM_TTL_MS: u64 = 10 * 60_000;

#[derive(Default)]
pub struct AmbientState {
    cues: Mutex<HashMap<String, Instant>>,
    speech: Mutex<HashMap<String, Instant>>,
}

fn prune(map: &mut HashMap<String, Instant>, ttl: Duration, now: Instant) {
    map.retain(|_, at| now.duration_since(*at) < ttl);
}

fn is_duplicate(map: &Mutex<HashMap<String, Instant>>, key: &str, ttl: Duration) -> bool {
    let now = Instant::now();
    let mut map = map.lock().unwrap_or_else(|p| p.into_inner());
    prune(&mut map, ttl, now);
    if map.contains_key(key) {
        return true;
    }
    map.insert(key.to_string(), now);
    false
}

impl AmbientState {
    pub fn owns(&self, key: &str) -> bool {
        if key.starts_with("speak:") {
            !is_duplicate(
                &self.speech,
                key,
                Duration::from_millis(SPEECH_CLAIM_TTL_MS),
            )
        } else {
            !is_duplicate(&self.cues, key, Duration::from_millis(DEDUPE_INTERVAL_MS))
        }
    }
}

#[tauri::command]
pub fn claim_ambient_cue(state: State<'_, AmbientState>, key: String) -> bool {
    state.owns(key.trim())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_claim_wins() {
        let state = AmbientState::default();
        assert!(state.owns("beep:1"));
        assert!(!state.owns("beep:1"));
        assert!(state.owns("beep:2"));
    }

    #[test]
    fn speak_keys_use_longer_ttl_bucket() {
        let state = AmbientState::default();
        assert!(state.owns("speak:msg-1"));
        assert!(!state.owns("speak:msg-1"));
        // Non-speak key is independent.
        assert!(state.owns("beep:msg-1"));
    }
}
