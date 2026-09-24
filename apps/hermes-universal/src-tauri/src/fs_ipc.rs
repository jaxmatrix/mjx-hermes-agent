//! Local filesystem IPC for the project tree and file surfaces — Electron's
//! `fs-ipc.ts` / `fs-read-dir.ts` / `git-root.ts`.
//!
//! Desktop-local only: a remote gateway's paths are not on this disk. Callers
//! feature-detect; mobile keeps these absent (no project tree file manager).

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::AppHandle;
#[cfg(desktop)]
use tauri_plugin_opener::OpenerExt;

/// Always-hidden noise (matches Electron `FS_READDIR_HIDDEN`).
const READDIR_HIDDEN: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    ".cache",
    ".next",
    ".turbo",
    ".venv",
    "__pycache__",
    "build",
    "dist",
    "node_modules",
    "target",
    "venv",
];

const WRITE_TEXT_MAX_CHARS: usize = 1_000_000;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadDirEntry {
    pub name: String,
    pub path: String,
    pub is_directory: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadDirResult {
    pub entries: Vec<ReadDirEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenDirResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathResult {
    pub path: String,
}

fn empty_read_error(code: &str) -> ReadDirResult {
    ReadDirResult {
        entries: Vec::new(),
        error: Some(code.to_string()),
    }
}

fn find_git_root(start: &Path) -> Option<PathBuf> {
    let mut dir = start.to_path_buf();

    for _ in 0..50 {
        if dir.join(".git").exists() {
            return Some(dir);
        }

        match dir.parent() {
            Some(parent) if parent != dir => dir = parent.to_path_buf(),
            _ => return None,
        }
    }

    None
}

/// Directory listing for the project tree. Hidden build/VCS dirs are filtered;
/// directories sort first, then name.
#[tauri::command]
pub fn fs_read_dir(path: String) -> ReadDirResult {
    let raw = path.trim();

    if raw.is_empty() || raw.contains('\0') {
        return empty_read_error("read-error");
    }

    let resolved = PathBuf::from(raw);
    let meta = match fs::metadata(&resolved) {
        Ok(m) if m.is_dir() => m,
        Ok(_) => return empty_read_error("ENOTDIR"),
        Err(err) => {
            return empty_read_error(
                err.raw_os_error()
                    .map(|c| c.to_string())
                    .as_deref()
                    .unwrap_or("read-error"),
            )
        }
    };
    let _ = meta;

    let read = match fs::read_dir(&resolved) {
        Ok(r) => r,
        Err(err) => {
            return empty_read_error(
                err.raw_os_error()
                    .map(|c| c.to_string())
                    .as_deref()
                    .unwrap_or("read-error"),
            )
        }
    };

    let mut entries = Vec::new();

    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();

        if READDIR_HIDDEN.contains(&name.as_str()) {
            continue;
        }

        let full = entry.path();
        let is_directory = entry.file_type().map(|t| t.is_dir()).unwrap_or(false)
            || fs::metadata(&full).map(|m| m.is_dir()).unwrap_or(false);

        entries.push(ReadDirEntry {
            name,
            path: full.to_string_lossy().into_owned(),
            is_directory,
        });
    }

    entries.sort_by(|a, b| {
        b.is_directory
            .cmp(&a.is_directory)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    ReadDirResult {
        entries,
        error: None,
    }
}

/// Walk up from `path` (file or dir) looking for a `.git` entry.
#[tauri::command]
pub fn fs_git_root(path: String) -> Option<String> {
    let raw = path.trim();

    if raw.is_empty() || raw.contains('\0') {
        return None;
    }

    let resolved = PathBuf::from(raw);
    let start = match fs::metadata(&resolved) {
        Ok(m) if m.is_dir() => resolved,
        Ok(_) => resolved.parent()?.to_path_buf(),
        Err(_) => resolved,
    };

    find_git_root(&start).map(|p| p.to_string_lossy().into_owned())
}

/// Create a directory if needed, then open it in the OS file manager.
#[tauri::command]
#[cfg(desktop)]
pub fn fs_open_dir(app: AppHandle, path: String) -> OpenDirResult {
    let dir = path.trim();

    if dir.is_empty() || dir.contains('\0') {
        return OpenDirResult {
            ok: false,
            error: Some("no path".into()),
        };
    }

    let path = PathBuf::from(dir);

    if let Err(err) = fs::create_dir_all(&path) {
        return OpenDirResult {
            ok: false,
            error: Some(err.to_string()),
        };
    }

    match app
        .opener()
        .open_path(path.to_string_lossy().as_ref(), None::<&str>)
    {
        Ok(()) => OpenDirResult {
            ok: true,
            error: None,
        },
        Err(err) => OpenDirResult {
            ok: false,
            error: Some(err.to_string()),
        },
    }
}

#[tauri::command]
#[cfg(not(desktop))]
pub fn fs_open_dir(_path: String) -> OpenDirResult {
    OpenDirResult {
        ok: false,
        error: Some("openDir is desktop-only".into()),
    }
}

/// Rename in place: new base name, same parent. Never traverses out.
#[tauri::command]
pub fn fs_rename(path: String, new_name: String) -> Result<PathResult, String> {
    let src = path.trim();
    let name = new_name.trim();

    if src.is_empty()
        || name.is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
        || name.contains('\0')
        || src.contains('\0')
    {
        return Err("Invalid rename".into());
    }

    let src_path = PathBuf::from(src);
    let parent = src_path
        .parent()
        .ok_or_else(|| "Invalid rename".to_string())?;
    let dst = parent.join(name);

    if dst == src_path {
        return Ok(PathResult {
            path: dst.to_string_lossy().into_owned(),
        });
    }

    if dst.exists() {
        return Err(format!("\"{name}\" already exists"));
    }

    fs::rename(&src_path, &dst).map_err(|e| e.to_string())?;

    Ok(PathResult {
        path: dst.to_string_lossy().into_owned(),
    })
}

/// Small UTF-8 write. Parent must already exist; content capped at 1M chars.
#[tauri::command]
pub fn fs_write_text(path: String, content: String) -> Result<PathResult, String> {
    let raw = path.trim();

    if raw.is_empty() || raw.contains('\0') {
        return Err("Invalid path".into());
    }

    if content.chars().count() > WRITE_TEXT_MAX_CHARS {
        return Err("Content too large".into());
    }

    let resolved = PathBuf::from(raw);
    let parent = resolved
        .parent()
        .ok_or_else(|| "Invalid path".to_string())?;

    if !parent.is_dir() {
        return Err("Parent directory does not exist".into());
    }

    fs::write(&resolved, content.as_bytes()).map_err(|e| e.to_string())?;

    Ok(PathResult {
        path: resolved.to_string_lossy().into_owned(),
    })
}

/// Move a path to the OS trash (recoverable). Desktop only.
#[tauri::command]
#[cfg(desktop)]
pub fn fs_trash(path: String) -> Result<bool, String> {
    let target = path.trim();

    if target.is_empty() || target.contains('\0') {
        return Err("Invalid delete".into());
    }

    trash::delete(target).map_err(|e| e.to_string())?;

    Ok(true)
}

#[tauri::command]
#[cfg(not(desktop))]
pub fn fs_trash(_path: String) -> Result<bool, String> {
    Err("trashPath is desktop-only".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn find_git_root_walks_up() {
        let dir = tempdir().unwrap();
        let nested = dir.path().join("a").join("b");
        fs::create_dir_all(&nested).unwrap();
        fs::create_dir(dir.path().join(".git")).unwrap();

        assert_eq!(find_git_root(&nested).as_deref(), Some(dir.path()));
    }

    #[test]
    fn read_dir_hides_node_modules() {
        let dir = tempdir().unwrap();
        fs::create_dir(dir.path().join("src")).unwrap();
        fs::create_dir(dir.path().join("node_modules")).unwrap();
        fs::write(dir.path().join("readme.md"), "x").unwrap();

        let result = fs_read_dir(dir.path().to_string_lossy().into_owned());

        assert!(result.error.is_none());
        let names: Vec<_> = result.entries.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"src"));
        assert!(names.contains(&"readme.md"));
        assert!(!names.contains(&"node_modules"));
        assert!(result.entries[0].is_directory);
    }

    #[test]
    fn rename_rejects_path_separators_in_name() {
        let err = fs_rename("/tmp/a".into(), "b/c".into()).unwrap_err();
        assert_eq!(err, "Invalid rename");
    }
}
