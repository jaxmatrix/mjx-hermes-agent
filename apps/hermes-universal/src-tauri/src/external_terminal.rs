//! Open the user's OS terminal application (MJXHRM-452).
//!
//! Distinct from the IN-APP terminal rail (`pty.rs`), which is a portable-pty
//! session rendered inside a Hermes pane. This one hands work to the desktop
//! environment's own terminal emulator and walks away.
//!
//! Two verbs:
//! - `open_in_terminal` — open a shell at a directory.
//! - `open_session_in_terminal` — write a one-shot launcher that runs
//!   `hermes --tui --resume <id>` (Electron `external-terminal.ts`) and open
//!   that in the user's terminal.
//!
//! Desktop only: `cfg(desktop)` at the registration site.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;
use tauri::{AppHandle, Manager};

/// Candidate terminals for a Linux/BSD desktop, in the order a session should be
/// offered one — directory flag for `open_in_terminal`.
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

/// Linux emulators that can run a script (`-e` / `--` style), matching Electron.
#[cfg(all(unix, not(target_os = "macos")))]
const LINUX_SCRIPT_TERMINALS: &[(&str, &str)] = &[
    ("x-terminal-emulator", "-e"),
    ("gnome-terminal", "--"),
    ("konsole", "-e"),
    ("xfce4-terminal", "-x"),
    ("tilix", "-e"),
    ("kitty", ""),
    ("alacritty", "-e"),
    ("wezterm", "-e"),
    ("foot", ""),
    ("xterm", "-e"),
];

#[derive(Clone, Serialize)]
pub struct OpenSessionResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn on_path(command: &str) -> bool {
    if command.contains('/') || command.contains('\\') {
        return Path::new(command).is_file();
    }

    std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).any(|dir| dir.join(command).is_file()))
        .unwrap_or(false)
}

fn find_on_path(command: &str) -> Option<String> {
    if command.contains('/') || command.contains('\\') {
        return Path::new(command).is_file().then(|| command.to_string());
    }

    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths).find_map(|dir| {
            let candidate = dir.join(command);
            candidate
                .is_file()
                .then(|| candidate.to_string_lossy().into_owned())
        })
    })
}

fn hermes_program() -> Result<String, String> {
    let program = std::env::var("HERMES_BIN").unwrap_or_else(|_| "hermes".to_string());
    if on_path(&program) || Path::new(&program).is_file() {
        return Ok(program);
    }
    Err("Hermes is not installed yet".into())
}

fn posix_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn windows_quote(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn tui_resume_args(session_id: &str, profile: Option<&str>) -> Vec<String> {
    let mut args = Vec::new();
    if let Some(profile) = profile.filter(|p| !p.is_empty()) {
        args.push("--profile".into());
        args.push(profile.to_string());
    }
    args.push("--tui".into());
    args.push("--resume".into());
    args.push(session_id.to_string());
    args
}

fn build_posix_script(
    command: &str,
    args: &[String],
    cwd: &str,
    hermes_home: Option<&str>,
) -> String {
    let mut lines = vec![
        "#!/bin/sh".to_string(),
        format!("cd {} || exit 1", posix_quote(cwd)),
    ];
    if let Some(home) = hermes_home {
        lines.push(format!("export HERMES_HOME={}", posix_quote(home)));
    }
    let exec = std::iter::once(command)
        .chain(args.iter().map(String::as_str))
        .map(posix_quote)
        .collect::<Vec<_>>()
        .join(" ");
    lines.push(format!("exec {exec}"));
    lines.push(String::new());
    lines.join("\n")
}

fn build_windows_script(
    command: &str,
    args: &[String],
    cwd: &str,
    hermes_home: Option<&str>,
) -> String {
    let mut lines = vec![
        "@echo off".to_string(),
        format!("cd /d {}", windows_quote(cwd)),
    ];
    if let Some(home) = hermes_home {
        lines.push(format!(
            "set {}",
            windows_quote(&format!("HERMES_HOME={home}"))
        ));
    }
    let cmdline = std::iter::once(command)
        .chain(args.iter().map(String::as_str))
        .map(windows_quote)
        .collect::<Vec<_>>()
        .join(" ");
    lines.push(cmdline);
    lines.push(String::new());
    lines.join("\r\n")
}

/// Launch the OS terminal at `cwd`.
#[tauri::command]
pub fn open_in_terminal(cwd: String) -> Result<(), String> {
    let dir = Path::new(&cwd);

    if !dir.is_dir() {
        return Err(format!("not a directory on this machine: {cwd}"));
    }

    spawn_terminal_at(dir)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenSessionOpts {
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub profile: Option<String>,
}

/// Resume a session in the user's terminal via `hermes --tui --resume`.
#[tauri::command]
pub fn open_session_in_terminal(
    app: AppHandle,
    session_id: String,
    opts: Option<OpenSessionOpts>,
) -> OpenSessionResult {
    let session_id = session_id.trim().to_string();
    if session_id.is_empty() {
        return OpenSessionResult {
            ok: false,
            error: Some("invalid-session-id".into()),
        };
    }

    let opts = opts.unwrap_or(OpenSessionOpts {
        cwd: None,
        profile: None,
    });

    match open_session_in_terminal_inner(
        &app,
        &session_id,
        opts.cwd.as_deref(),
        opts.profile.as_deref(),
    ) {
        Ok(()) => OpenSessionResult {
            ok: true,
            error: None,
        },
        Err(error) => OpenSessionResult {
            ok: false,
            error: Some(error),
        },
    }
}

fn open_session_in_terminal_inner(
    app: &AppHandle,
    session_id: &str,
    cwd: Option<&str>,
    profile: Option<&str>,
) -> Result<(), String> {
    let program = hermes_program()?;
    let args = tui_resume_args(session_id, profile);

    let cwd = cwd
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
        .or_else(|| app.path().home_dir().ok())
        .ok_or_else(|| "no usable working directory".to_string())?;

    let hermes_home = crate::plugins::hermes_home().map(|p| p.to_string_lossy().into_owned());

    let script_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("open-in-terminal");
    fs::create_dir_all(&script_dir).map_err(|e| e.to_string())?;

    let (ext, body) = if cfg!(windows) {
        (
            ".cmd",
            build_windows_script(
                &program,
                &args,
                &cwd.to_string_lossy(),
                hermes_home.as_deref(),
            ),
        )
    } else if cfg!(target_os = "macos") {
        (
            ".command",
            build_posix_script(
                &program,
                &args,
                &cwd.to_string_lossy(),
                hermes_home.as_deref(),
            ),
        )
    } else {
        (
            ".sh",
            build_posix_script(
                &program,
                &args,
                &cwd.to_string_lossy(),
                hermes_home.as_deref(),
            ),
        )
    };

    let nonce = format!(
        "{:x}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    let script_path = script_dir.join(format!("hermes-{nonce}{ext}"));
    fs::write(&script_path, body.as_bytes()).map_err(|e| e.to_string())?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&script_path)
            .map_err(|e| e.to_string())?
            .permissions();
        perms.set_mode(0o700);
        fs::set_permissions(&script_path, perms).map_err(|e| e.to_string())?;
    }

    spawn_script(&script_path)
}

#[cfg(target_os = "macos")]
fn spawn_terminal_at(dir: &Path) -> Result<(), String> {
    Command::new("open")
        .arg("-a")
        .arg("Terminal")
        .arg(dir)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(windows)]
fn spawn_terminal_at(dir: &Path) -> Result<(), String> {
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
fn spawn_terminal_at(dir: &Path) -> Result<(), String> {
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

fn spawn_script(script: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        return Command::new("open")
            .arg(script)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string());
    }

    #[cfg(windows)]
    {
        if let Some(wt) = find_on_path("wt.exe") {
            return Command::new(wt)
                .args(["cmd.exe", "/k"])
                .arg(script)
                .spawn()
                .map(|_| ())
                .map_err(|e| e.to_string());
        }
        return Command::new("cmd.exe")
            .args(["/c", "start", "", "cmd.exe", "/k"])
            .arg(script)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        for (command, flag) in LINUX_SCRIPT_TERMINALS {
            let Some(resolved) = find_on_path(command) else {
                continue;
            };
            let mut cmd = Command::new(&resolved);
            if !flag.is_empty() {
                cmd.arg(flag);
            }
            cmd.arg("/bin/sh").arg(script);
            if cmd.spawn().is_ok() {
                return Ok(());
            }
        }
        Err("No terminal emulator found".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tui_resume_pins_profile() {
        assert_eq!(
            tui_resume_args("sess", Some("work")),
            vec!["--profile", "work", "--tui", "--resume", "sess"]
        );
        assert_eq!(
            tui_resume_args("sess", None),
            vec!["--tui", "--resume", "sess"]
        );
    }

    #[test]
    fn posix_script_exports_home_and_execs() {
        let script = build_posix_script(
            "/opt/hermes",
            &["--tui".into(), "--resume".into(), "s1".into()],
            "/proj",
            Some("/home/me/.hermes"),
        );
        assert!(script.contains("export HERMES_HOME='/home/me/.hermes'"));
        assert!(script.contains("exec '/opt/hermes' '--tui' '--resume' 's1'"));
        assert!(script.contains("cd '/proj'"));
    }
}
