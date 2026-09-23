//! Open the user's OS terminal application at a directory (MJXHRM-452).
//!
//! Distinct from the IN-APP terminal rail (`pty.rs`), which is a portable-pty
//! session rendered inside a Hermes pane. This one hands the directory to the
//! desktop environment's own terminal emulator and walks away — the point is to
//! get OUT of the app, into the shell the user has configured.
//!
//! Desktop only: `cfg(desktop)` at the registration site. A phone has no
//! terminal emulator to hand a directory to, and Tauri's mobile targets have no
//! `Command::spawn` story worth pretending about.
//!
//! Deliberately NOT desktop's full `external-terminal.ts`. That one writes a
//! shell script that re-execs the Hermes runtime with `--tui --resume <id>`,
//! which needs the resolved interpreter, PYTHONPATH and HERMES_HOME that
//! Electron's main process owns. Universal's Rust backend does not own an
//! equivalent, so this ships the honest half — open a terminal AT the session's
//! cwd — and TUI resume is left to a follow-up that can resolve the runtime.

use std::path::Path;
use std::process::Command;

/// Candidate terminals for a Linux/BSD desktop, in the order a session should be
/// offered one.
///
/// `$TERMINAL` first because it is the user's own explicit answer, then Debian's
/// `x-terminal-emulator` alternative (the distro's configured default), then the
/// desktop-environment terminals, then the common standalones. Each entry pairs
/// the binary with the flag that means "start in this directory" — they are NOT
/// interchangeable, which is the whole reason this is a table and not a loop
/// over names.
#[cfg(all(unix, not(target_os = "macos")))]
const UNIX_TERMINALS: &[(&str, &str)] = &[
    ("x-terminal-emulator", "--working-directory"),
    ("gnome-terminal", "--working-directory"),
    ("kgx", "--working-directory"),
    ("ptyxis", "--working-directory"),
    ("tilix", "--working-directory"),
    ("konsole", "--workdir"),
    ("xfce4-terminal", "--working-directory"),
    ("mate-terminal", "--working-directory"),
    ("alacritty", "--working-directory"),
    ("kitty", "--directory"),
    ("wezterm", "--cwd"),
    ("foot", "--working-directory"),
];

/// Is `command` runnable on this machine?
///
/// A plain `PATH` walk rather than `which`: the fallback chain asks this once
/// per candidate, and shelling out a dozen times to answer "does this file
/// exist" is a process spawn per question for no added truth.
#[cfg(all(unix, not(target_os = "macos")))]
fn on_path(command: &str) -> bool {
    if command.contains('/') {
        return Path::new(command).is_file();
    }

    std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).any(|dir| dir.join(command).is_file()))
        .unwrap_or(false)
}

/// Launch the OS terminal at `cwd`.
///
/// The directory is validated here rather than trusted: `cwd` arrives from a
/// session row, and a session can outlive the directory it was started in (a
/// deleted worktree, an unmounted volume, a remote profile's path that does not
/// exist on THIS machine). Spawning a terminal into a missing directory either
/// fails opaquely or silently drops the user in `$HOME`, and both read as "the
/// menu item is broken".
#[tauri::command]
pub fn open_in_terminal(cwd: String) -> Result<(), String> {
    let dir = Path::new(&cwd);

    if !dir.is_dir() {
        return Err(format!("not a directory on this machine: {cwd}"));
    }

    spawn_terminal(dir)
}

#[cfg(target_os = "macos")]
fn spawn_terminal(dir: &Path) -> Result<(), String> {
    // No `-a Terminal`: `open` with a directory and no app hands it to
    // LaunchServices, which honours the user's chosen terminal (iTerm2, Ghostty,
    // WezTerm) instead of forcing Apple's.
    Command::new("open")
        .arg("-a")
        .arg("Terminal")
        .arg(dir)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(windows)]
fn spawn_terminal(dir: &Path) -> Result<(), String> {
    // Windows Terminal when it is installed (the modern default since Win11),
    // else a plain console. `-d` and `/d` both mean "start here".
    Command::new("wt.exe")
        .arg("-d")
        .arg(dir)
        .spawn()
        .or_else(|_| {
            Command::new("cmd.exe")
                .args(["/c", "start", "", "cmd.exe", "/k", "cd", "/d"])
                .arg(dir)
                .spawn()
        })
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn spawn_terminal(dir: &Path) -> Result<(), String> {
    // `$TERMINAL` is the user's explicit answer and takes precedence over every
    // heuristic below. It carries no directory flag, so it gets `cd`'d into via
    // the child's working directory instead — which is also why it cannot just
    // be prepended to the table.
    if let Some(terminal) = std::env::var_os("TERMINAL") {
        let terminal = terminal.to_string_lossy().to_string();

        if !terminal.is_empty() && on_path(&terminal) {
            if Command::new(&terminal).current_dir(dir).spawn().is_ok() {
                return Ok(());
            }
        }
    }

    for (command, flag) in UNIX_TERMINALS {
        if !on_path(command) {
            continue;
        }

        // `current_dir` as well as the flag: a couple of these (notably
        // gnome-terminal talking to an already-running server) ignore the flag
        // in some configurations, and inheriting Hermes' own cwd would drop the
        // user somewhere arbitrary rather than in the session's project.
        if Command::new(command)
            .arg(flag)
            .arg(dir)
            .current_dir(dir)
            .spawn()
            .is_ok()
        {
            return Ok(());
        }
    }

    Err("no terminal emulator found — set $TERMINAL to the one you use".into())
}
