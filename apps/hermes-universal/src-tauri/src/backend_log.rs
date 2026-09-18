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

/// When the live file rotates, how many backups it keeps, and when it is
/// discarded outright.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub max_bytes: u64,
    pub backups: usize,
    pub discard_bytes: u64,
}

pub const LIMITS: Limits = Limits {
    max_bytes: MAX_BYTES,
    backups: BACKUP_COUNT,
    discard_bytes: DISCARD_BYTES,
};

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

/// The ordered, best-effort file operations that bound a live log of `size`
/// under the production limits. Upstream's `planDesktopLogRotation`.
#[cfg(test)]
pub fn plan_rotation(live: &Path, size: u64) -> Vec<RotateOp> {
    plan_rotation_with(live, size, LIMITS)
}

pub fn plan_rotation_with(live: &Path, size: u64, limits: Limits) -> Vec<RotateOp> {
    if size < limits.max_bytes {
        return Vec::new();
    }

    if size > limits.discard_bytes {
        return std::iter::once(live.to_path_buf())
            .chain((1..=limits.backups).map(|n| backup_path(live, n)))
            .map(RotateOp::Remove)
            .collect();
    }

    let mut ops = vec![RotateOp::Remove(backup_path(live, limits.backups))];

    for n in (1..limits.backups).rev() {
        ops.push(RotateOp::Rename(
            backup_path(live, n),
            backup_path(live, n + 1),
        ));
    }

    ops.push(RotateOp::Rename(live.to_path_buf(), backup_path(live, 1)));

    ops
}

/// How many lines may wait for the writer. Past this a line is dropped and
/// counted, so a backend printing faster than the disk takes it can never block
/// the task draining its pipe.
pub const QUEUE_LINES: usize = 4096;

pub struct BackendLog {
    ring: Mutex<VecDeque<String>>,
    /// Feeds the one writer thread, which alone touches the file. Taken on close.
    writer: Mutex<Option<std::sync::mpsc::SyncSender<String>>>,
    /// Signalled by the writer once everything queued before close is on disk.
    finished: Mutex<Option<std::sync::mpsc::Receiver<()>>>,
    dropped: std::sync::atomic::AtomicU64,
}

impl BackendLog {
    /// `path` of `None` keeps the ring only.
    pub fn new(path: Option<PathBuf>) -> Self {
        Self::with_limits(path, LIMITS)
    }

    pub fn with_limits(path: Option<PathBuf>, limits: Limits) -> Self {
        Self::with_queue(path, limits, QUEUE_LINES, None)
    }

    /// `gate`: the writer waits for it before writing anything (tests only).
    fn with_queue(
        path: Option<PathBuf>,
        limits: Limits,
        queue: usize,
        gate: Option<std::sync::mpsc::Receiver<()>>,
    ) -> Self {
        let (writer, finished) = match path {
            Some(path) => {
                let (tx, rx) = std::sync::mpsc::sync_channel::<String>(queue);
                let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
                let spawned = std::thread::Builder::new()
                    .name("hermes-backend-log".to_string())
                    .spawn(move || {
                        if let Some(gate) = gate {
                            let _ = gate.recv();
                        }

                        write_lines(&path, limits, rx);
                        let _ = done_tx.send(());
                    });

                match spawned {
                    Ok(_) => (Some(tx), Some(done_rx)),
                    Err(_) => (None, None),
                }
            }
            None => (None, None),
        };

        Self {
            ring: Mutex::new(VecDeque::with_capacity(RING_LINES)),
            writer: Mutex::new(writer),
            finished: Mutex::new(finished),
            dropped: Default::default(),
        }
    }

    /// Lines dropped because the writer's queue was full.
    pub fn dropped(&self) -> u64 {
        self.dropped.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Stop accepting lines and wait, at most `deadline`, for the writer to put
    /// what is queued on disk. Managed state is never dropped at exit, so quit
    /// calls this. True when everything queued was written.
    pub fn close_and_join(&self, deadline: std::time::Duration) -> bool {
        self.writer.lock().unwrap_or_else(|p| p.into_inner()).take();

        let finished = self
            .finished
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take();

        match finished {
            Some(finished) => finished.recv_timeout(deadline).is_ok(),
            None => true,
        }
    }

    pub fn at_hermes_home() -> Self {
        Self::new(crate::plugins::hermes_home().map(|home| home.join("logs").join(FILE_NAME)))
    }

    /// Never touches the disk: the line is queued for the writer thread, so a
    /// chatty backend cannot stall the async runtime that drains it.
    pub fn push(&self, line: &str) {
        let line = format!(
            "{} {}",
            crate::ssh::clock::now_iso8601(),
            crate::transport::redact_message(line.trim_end().to_string())
        );

        if let Some(writer) = &*self.writer.lock().unwrap_or_else(|p| p.into_inner()) {
            if let Err(std::sync::mpsc::TrySendError::Full(_)) = writer.try_send(line.clone()) {
                self.dropped
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            }
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

impl Drop for BackendLog {
    /// Close the queue and let the writer finish what it was sent.
    fn drop(&mut self) {
        self.close_and_join(std::time::Duration::from_secs(5));
    }
}

fn rotate(path: &Path, size: u64, limits: Limits) {
    for op in plan_rotation_with(path, size, limits) {
        let _ = match op {
            RotateOp::Remove(target) => std::fs::remove_file(target),
            RotateOp::Rename(from, to) => std::fs::rename(from, to),
        };
    }
}

/// The writer thread: the only code that opens, sizes, rotates or writes the
/// file, so no two rotations can ever run at once. Logging must never block or
/// fail the backend, so every step is best-effort.
fn write_lines(path: &Path, limits: Limits, lines: std::sync::mpsc::Receiver<String>) {
    let mut file: Option<std::fs::File> = None;
    let mut size = 0u64;

    for line in lines {
        if file.is_none() {
            if let Some(dir) = path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }

            // A file a previous run left too large is bounded before appending.
            rotate(
                path,
                std::fs::metadata(path).map(|m| m.len()).unwrap_or(0),
                limits,
            );
            size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
            file = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
                .ok();
        }

        if let Some(handle) = file.as_mut() {
            if writeln!(handle, "{line}").is_ok() {
                size += line.len() as u64 + 1;
            }
        }

        if size >= limits.max_bytes {
            file = None;
            rotate(path, size, limits);
            size = 0;
        }
    }
}

/// Wait for a killed child's drains until `until` at most. A drain can still be
/// reading the child's last lines after the kill, and the log must not close
/// under it; a grandchild holding the pipe open is what the deadline is for.
pub async fn await_drains(drains: Vec<tokio::task::JoinHandle<()>>, until: tokio::time::Instant) {
    let _ = tokio::time::timeout_at(until, async {
        for drain in drains {
            let _ = drain.await;
        }
    })
    .await;
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
    fn one_writer_rotates_the_file_it_owns() {
        let dir = std::env::temp_dir().join(format!(
            "hermes-backend-log-{}-{}",
            std::process::id(),
            crate::ssh::clock::now_iso8601().replace(':', "")
        ));
        let live = dir.join(FILE_NAME);
        let limits = Limits {
            max_bytes: 200,
            backups: 2,
            discard_bytes: 800,
        };

        let _ = std::fs::remove_dir_all(&dir);

        {
            let log = BackendLog::with_limits(Some(live.clone()), limits);

            for n in 0..40 {
                log.push(&format!("backend line {n:02}"));
            }
        }

        assert!(backup_path(&live, 1).exists(), "rotated at least once");
        assert!(backup_path(&live, 2).exists(), "kept a second backup");
        assert!(!backup_path(&live, 3).exists(), "never more than two");
        assert!(std::fs::metadata(backup_path(&live, 1)).unwrap().len() >= limits.max_bytes);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_full_queue_drops_instead_of_blocking_and_close_flushes_the_rest() {
        let dir = std::env::temp_dir().join(format!(
            "hermes-backend-log-queue-{}-{}",
            std::process::id(),
            crate::ssh::clock::now_iso8601().replace(':', "")
        ));
        let live = dir.join(FILE_NAME);
        let (open_gate, gate) = std::sync::mpsc::channel::<()>();
        let log = std::sync::Arc::new(BackendLog::with_queue(
            Some(live.clone()),
            LIMITS,
            4,
            Some(gate),
        ));
        let (pushed_tx, pushed) = std::sync::mpsc::channel::<()>();

        let _ = std::fs::remove_dir_all(&dir);

        // The writer is held at its gate, so the queue fills after four lines.
        let pusher = std::sync::Arc::clone(&log);
        std::thread::spawn(move || {
            for n in 0..50 {
                pusher.push(&format!("queued line {n:02}"));
            }

            let _ = pushed_tx.send(());
        });

        assert!(
            pushed
                .recv_timeout(std::time::Duration::from_secs(5))
                .is_ok(),
            "a full queue must never block the pusher"
        );
        assert_eq!(log.dropped(), 46);

        open_gate.send(()).unwrap();

        assert!(log.close_and_join(std::time::Duration::from_secs(5)));

        let written = std::fs::read_to_string(&live).unwrap_or_default();

        assert_eq!(written.lines().count(), 4, "{written}");
        assert!(written.lines().last().unwrap().ends_with("queued line 03"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn quit_waits_for_a_drain_still_reading_the_killed_childs_last_line() {
        let dir = std::env::temp_dir().join(format!(
            "hermes-backend-log-drain-{}-{}",
            std::process::id(),
            crate::ssh::clock::now_iso8601().replace(':', "")
        ));
        let live = dir.join(FILE_NAME);
        let log = std::sync::Arc::new(BackendLog::new(Some(live.clone())));
        let (mut child_pipe, drained_end) = tokio::io::duplex(64);

        let _ = std::fs::remove_dir_all(&dir);

        let drain = tokio::spawn(drain(drained_end, std::sync::Arc::clone(&log)));
        let until = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        let waiting = await_drains(vec![drain], until);

        tokio::pin!(waiting);

        // Quit is already waiting when the killed child's last line arrives.
        assert!(
            tokio::time::timeout(std::time::Duration::ZERO, &mut waiting)
                .await
                .is_err(),
            "the drain is still reading"
        );

        {
            use tokio::io::AsyncWriteExt;

            child_pipe.write_all(b"the last line\n").await.unwrap();
        }
        drop(child_pipe);

        waiting.await;

        assert!(log.close_and_join(std::time::Duration::from_secs(5)));

        let written = std::fs::read_to_string(&live).unwrap_or_default();

        assert!(written.ends_with("the last line\n"), "{written:?}");

        let _ = std::fs::remove_dir_all(&dir);
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
