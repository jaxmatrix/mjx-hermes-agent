//! The local backend's output (MJXHRM-592).
//!
//! The spawned `hermes serve` writes to stdout and stderr for as long as it
//! lives. A pipe nobody reads fills (64 KiB on Linux) and the child blocks on
//! its next write, which for a backend reused across switches and held by
//! background leases is a hang waiting to happen.
//!
//! Ported from upstream desktop (`apps/desktop/electron/main.ts`): both streams
//! feed one drain from the moment of spawn; each line is redacted, kept in a
//! 300-line ring and appended to `HERMES_HOME/logs/universal-backend.log` next
//! to `agent.log`; the file rotates like `desktop.log` (10 MiB × 3 backups,
//! deleted outright past 40 MiB); and the ring's tail rides failure messages.

use std::collections::VecDeque;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};

pub const RING_LINES: usize = 300;
pub const TAIL_LINES: usize = 20;
pub const MAX_BYTES: u64 = 10 * 1024 * 1024;
pub const BACKUP_COUNT: usize = 3;
/// Past this a log is a boot-loop transcript with no diagnostic value.
pub const DISCARD_BYTES: u64 = MAX_BYTES * 4;
pub const FILE_NAME: &str = "universal-backend.log";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RotateOp {
    Remove(PathBuf),
    Rename(PathBuf, PathBuf),
}

pub fn backup_path(live: &Path, n: usize) -> PathBuf {
    let mut name = live.as_os_str().to_os_string();

    name.push(format!(".{n}"));

    PathBuf::from(name)
}

/// The ordered, best-effort file operations that bound a live log of `size`.
/// Upstream's `planDesktopLogRotation`.
pub fn plan_rotation(live: &Path, size: u64) -> Vec<RotateOp> {
    if size < MAX_BYTES {
        return Vec::new();
    }

    if size > DISCARD_BYTES {
        return std::iter::once(live.to_path_buf())
            .chain((1..=BACKUP_COUNT).map(|n| backup_path(live, n)))
            .map(RotateOp::Remove)
            .collect();
    }

    let mut ops = vec![RotateOp::Remove(backup_path(live, BACKUP_COUNT))];

    for n in (1..BACKUP_COUNT).rev() {
        ops.push(RotateOp::Rename(
            backup_path(live, n),
            backup_path(live, n + 1),
        ));
    }

    ops.push(RotateOp::Rename(live.to_path_buf(), backup_path(live, 1)));

    ops
}

pub struct BackendLog {
    ring: Mutex<VecDeque<String>>,
    path: Option<PathBuf>,
}

impl BackendLog {
    /// `path` of `None` keeps the ring only.
    pub fn new(path: Option<PathBuf>) -> Self {
        Self {
            ring: Mutex::new(VecDeque::with_capacity(RING_LINES)),
            path,
        }
    }

    pub fn at_hermes_home() -> Self {
        Self::new(crate::plugins::hermes_home().map(|home| home.join("logs").join(FILE_NAME)))
    }

    pub fn push(&self, line: &str) {
        let line = format!(
            "{} {}",
            crate::ssh::clock::now_iso8601(),
            crate::transport::redact_message(line.trim_end().to_string())
        );

        if let Some(path) = &self.path {
            append(path, &line);
        }

        let mut ring = self.ring.lock().unwrap_or_else(|p| p.into_inner());

        if ring.len() == RING_LINES {
            ring.pop_front();
        }

        ring.push_back(line);
    }

    pub fn tail(&self, lines: usize) -> Vec<String> {
        let ring = self.ring.lock().unwrap_or_else(|p| p.into_inner());

        ring.iter()
            .skip(ring.len().saturating_sub(lines))
            .cloned()
            .collect()
    }

    /// `message`, followed by the last 20 lines the backend printed.
    pub fn with_tail(&self, message: impl Into<String>) -> String {
        let message = message.into();
        let tail = self.tail(TAIL_LINES);

        if tail.is_empty() {
            message
        } else {
            format!("{message}\n{}", tail.join("\n"))
        }
    }
}

/// Logging must never block or fail the backend: every step is best-effort.
fn append(path: &Path, line: &str) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }

    if let Ok(meta) = std::fs::metadata(path) {
        for op in plan_rotation(path, meta.len()) {
            let _ = match op {
                RotateOp::Remove(target) => std::fs::remove_file(target),
                RotateOp::Rename(from, to) => std::fs::rename(from, to),
            };
        }
    }

    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = writeln!(file, "{line}");
    }
}

/// Read a stream to its end, feeding every line to `log`.
pub async fn drain<R: AsyncRead + Unpin>(stream: R, log: std::sync::Arc<BackendLog>) {
    let mut lines = BufReader::new(stream).lines();

    while let Ok(Some(line)) = lines.next_line().await {
        log.push(&line);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_small_log_is_left_alone() {
        assert!(plan_rotation(Path::new("/l/x.log"), MAX_BYTES - 1).is_empty());
    }

    #[test]
    fn a_full_log_cascades_into_three_backups() {
        let live = Path::new("/l/x.log");

        assert_eq!(
            plan_rotation(live, MAX_BYTES),
            vec![
                RotateOp::Remove(PathBuf::from("/l/x.log.3")),
                RotateOp::Rename(PathBuf::from("/l/x.log.2"), PathBuf::from("/l/x.log.3")),
                RotateOp::Rename(PathBuf::from("/l/x.log.1"), PathBuf::from("/l/x.log.2")),
                RotateOp::Rename(PathBuf::from("/l/x.log"), PathBuf::from("/l/x.log.1")),
            ]
        );
    }

    #[test]
    fn a_runaway_log_is_discarded_with_its_backups() {
        let live = Path::new("/l/x.log");

        assert_eq!(
            plan_rotation(live, DISCARD_BYTES + 1),
            vec![
                RotateOp::Remove(PathBuf::from("/l/x.log")),
                RotateOp::Remove(PathBuf::from("/l/x.log.1")),
                RotateOp::Remove(PathBuf::from("/l/x.log.2")),
                RotateOp::Remove(PathBuf::from("/l/x.log.3")),
            ]
        );
    }

    #[test]
    fn the_ring_keeps_the_last_300_lines_and_redacts_them() {
        let log = BackendLog::new(None);

        for n in 0..(RING_LINES + 50) {
            log.push(&format!("line {n}"));
        }

        log.push("GET /api/ws?token=abcdef123456");

        let kept = log.tail(usize::MAX);

        assert_eq!(kept.len(), RING_LINES);
        assert!(kept[0].ends_with(" line 51"), "{}", kept[0]);
        assert!(!kept.last().unwrap().contains("abcdef123456"));

        let message = log.with_tail("backend exited");

        assert_eq!(message.lines().count(), 1 + TAIL_LINES);
    }
}
