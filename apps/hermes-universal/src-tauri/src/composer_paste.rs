//! Composer paste / clipboard image writes — Electron `composer-paste.ts`,
//! `writeComposerImage` in main, and `wsl-clipboard-image.ts`.
//!
//! - Pasted text → `<HERMES_HOME>/composer-pastes/` (backend admits `@file:` only
//!   from that tree — not from Tauri's app-data dir).
//! - Image buffers / clipboard PNG → `<app_data>/composer-images/`.
//! - On WSL, when the Linux clipboard has no image, fall back to PowerShell on
//!   the Windows host (WSLg bridges text, not images).

use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use tauri::{AppHandle, Manager, Runtime};
#[cfg(desktop)]
use tauri_plugin_clipboard_manager::ClipboardExt;

pub const COMPOSER_PASTES_DIRNAME: &str = "composer-pastes";
const COMPOSER_IMAGES_DIRNAME: &str = "composer-images";

const PNG_SIGNATURE: [u8; 8] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const WSL_PS_SCRIPT: &str = concat!(
    "Add-Type -AssemblyName System.Windows.Forms,System.Drawing\n",
    "$img = [System.Windows.Forms.Clipboard]::GetImage()\n",
    "if ($null -eq $img) { exit 0 }\n",
    "$ms = New-Object System.IO.MemoryStream\n",
    "$img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)\n",
    "[Console]::Out.Write([System.Convert]::ToBase64String($ms.ToArray()))"
);

fn stamp_now() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    // ISO-ish without needing chrono: YYYY-ish not required — Electron uses
    // toISOString; uniqueness comes from stamp + random. Millis + random is
    // enough for collision avoidance.
    format!("{millis}")
}

fn random_hex3() -> String {
    let mut buf = [0u8; 3];
    let _ = getrandom::getrandom(&mut buf);
    hex::encode(buf)
}

fn safe_ext(ext: Option<&str>) -> String {
    let raw = ext.unwrap_or(".png").trim().to_ascii_lowercase();
    let normalized = if raw.starts_with('.') {
        raw
    } else {
        format!(".{raw}")
    };

    if normalized.len() >= 2
        && normalized.len() <= 6
        && normalized
            .bytes()
            .skip(1)
            .all(|b| b.is_ascii_alphanumeric())
    {
        normalized
    } else {
        ".png".into()
    }
}

fn safe_base_name(name: Option<&str>) -> String {
    let raw = name.unwrap_or("").trim();
    if raw.is_empty() {
        return String::new();
    }

    let leaf = raw.rsplit(['/', '\\']).next().unwrap_or(raw);
    let without_ext = match leaf.rsplit_once('.') {
        Some((stem, _)) if !stem.is_empty() => stem,
        _ => leaf,
    };

    let cleaned: String = without_ext
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '.' || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();

    cleaned
        .trim_matches(|c| c == '.' || c == '_' || c == '-')
        .chars()
        .take(80)
        .collect()
}

fn composer_images_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("saveImageBuffer: no app data dir: {e}"))?;
    let dir = root.join(COMPOSER_IMAGES_DIRNAME);
    fs::create_dir_all(&dir).map_err(|e| format!("saveImageBuffer: mkdir: {e}"))?;
    Ok(dir)
}

fn write_composer_image<R: Runtime>(
    app: &AppHandle<R>,
    bytes: &[u8],
    ext: Option<&str>,
    name: Option<&str>,
) -> Result<String, String> {
    let dir = composer_images_dir(app)?;
    let safe_ext = safe_ext(ext);
    let safe_name = safe_base_name(name);
    let random = random_hex3();

    let file_name = if safe_name.is_empty() {
        format!("composer_{}_{}{}", stamp_now(), random, safe_ext)
    } else {
        format!("{safe_name}_{random}{safe_ext}")
    };

    let file_path = dir.join(file_name);
    fs::write(&file_path, bytes).map_err(|e| format!("saveImageBuffer: write: {e}"))?;
    Ok(file_path.to_string_lossy().into_owned())
}

fn write_composer_paste(hermes_home: &Path, text: &str) -> Result<String, String> {
    let dir = hermes_home.join(COMPOSER_PASTES_DIRNAME);
    fs::create_dir_all(&dir).map_err(|e| format!("savePastedText: mkdir: {e}"))?;
    let file_path = dir.join(format!(
        "pasted_content_{}_{}.txt",
        stamp_now(),
        random_hex3()
    ));
    fs::write(&file_path, text.as_bytes()).map_err(|e| format!("savePastedText: write: {e}"))?;
    Ok(file_path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn save_image_buffer<R: Runtime>(
    app: AppHandle<R>,
    data_base64: String,
    ext: Option<String>,
    name: Option<String>,
) -> Result<String, String> {
    if data_base64.trim().is_empty() {
        return Err("saveImageBuffer: missing data".into());
    }

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.trim())
        .map_err(|_| "saveImageBuffer: data is not valid base64".to_string())?;

    if bytes.is_empty() {
        return Err("saveImageBuffer: missing data".into());
    }

    write_composer_image(&app, &bytes, ext.as_deref(), name.as_deref())
}

#[tauri::command]
pub fn save_pasted_text(text: String) -> Result<String, String> {
    if text.is_empty() {
        return Err("savePastedText: missing text".into());
    }

    let home = crate::plugins::hermes_home()
        .ok_or_else(|| "savePastedText: could not resolve HERMES_HOME".to_string())?;

    write_composer_paste(&home, &text)
}

fn rgba_to_png(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    let expected = (width as usize)
        .checked_mul(height as usize)
        .and_then(|n| n.checked_mul(4))
        .ok_or_else(|| "saveClipboardImage: image dimensions overflow".to_string())?;

    if rgba.len() < expected {
        return Err("saveClipboardImage: image buffer too short".into());
    }

    let img = image::RgbaImage::from_raw(width, height, rgba[..expected].to_vec())
        .ok_or_else(|| "saveClipboardImage: bad RGBA buffer".to_string())?;

    let mut out = Cursor::new(Vec::new());
    img.write_to(&mut out, image::ImageFormat::Png)
        .map_err(|e| format!("saveClipboardImage: png encode: {e}"))?;
    Ok(out.into_inner())
}

fn is_wsl() -> bool {
    if !cfg!(target_os = "linux") {
        return false;
    }

    if std::env::var_os("WSL_DISTRO_NAME").is_some() || std::env::var_os("WSL_INTEROP").is_some() {
        return true;
    }

    fs::read_to_string("/proc/sys/kernel/osrelease")
        .map(|release| {
            let lower = release.to_ascii_lowercase();
            lower.contains("microsoft") || lower.contains("wsl")
        })
        .unwrap_or(false)
}

fn encode_powershell_command(script: &str) -> String {
    let utf16: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    base64::engine::general_purpose::STANDARD.encode(utf16)
}

fn decode_clipboard_image_base64(stdout: &str) -> Option<Vec<u8>> {
    let b64 = stdout.trim();
    if b64.is_empty() {
        return None;
    }

    let buffer = base64::engine::general_purpose::STANDARD.decode(b64).ok()?;
    if buffer.len() < PNG_SIGNATURE.len() || buffer[..PNG_SIGNATURE.len()] != PNG_SIGNATURE {
        return None;
    }

    Some(buffer)
}

fn powershell_candidates() -> &'static [&'static str] {
    &[
        "powershell.exe",
        "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
    ]
}

/// Read a Windows-host clipboard image from inside WSL. Never throws — `None`
/// when empty / unreachable / invalid (Electron `readWslWindowsClipboardImage`).
fn read_wsl_windows_clipboard_image() -> Option<Vec<u8>> {
    let encoded = encode_powershell_command(WSL_PS_SCRIPT);

    for ps in powershell_candidates() {
        let output = Command::new(ps)
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-STA",
                "-ExecutionPolicy",
                "Bypass",
                "-EncodedCommand",
                &encoded,
            ])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .stdin(std::process::Stdio::null())
            .output();

        let Ok(output) = output else {
            continue;
        };

        let stdout = String::from_utf8_lossy(&output.stdout);
        if let Some(png) = decode_clipboard_image_base64(&stdout) {
            return Some(png);
        }

        if stdout.trim().is_empty() {
            return None;
        }
    }

    None
}

/// Empty string when the clipboard has no image (Electron contract).
#[tauri::command]
pub fn save_clipboard_image<R: Runtime>(app: AppHandle<R>) -> Result<String, String> {
    #[cfg(desktop)]
    {
        if let Ok(image) = app.clipboard().read_image() {
            let rgba = image.rgba();
            let width = image.width();
            let height = image.height();

            if width > 0 && height > 0 && !rgba.is_empty() {
                let png = rgba_to_png(rgba, width, height)?;
                return write_composer_image(&app, &png, Some(".png"), None);
            }
        }

        if is_wsl() {
            if let Some(png) = read_wsl_windows_clipboard_image() {
                return write_composer_image(&app, &png, Some(".png"), None);
            }
        }

        Ok(String::new())
    }

    #[cfg(mobile)]
    {
        let _ = app;
        Ok(String::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_ext_normalizes() {
        assert_eq!(safe_ext(Some("PNG")), ".png");
        assert_eq!(safe_ext(Some(".html")), ".html");
        assert_eq!(safe_ext(Some("...")), ".png");
        assert_eq!(safe_ext(Some(".toolongext")), ".png");
    }

    #[test]
    fn safe_base_name_strips_path_and_ext() {
        assert_eq!(
            safe_base_name(Some("Screen Shot 2026-08-11.png")),
            "Screen_Shot_2026-08-11"
        );
        assert_eq!(safe_base_name(Some("/tmp/a/b.png")), "b");
        assert_eq!(safe_base_name(Some("")), "");
    }

    #[test]
    fn write_composer_paste_lands_under_hermes_home() {
        let home = tempfile_dir("hermes-paste-");
        let path = write_composer_paste(&home, "pasted body").expect("write");
        assert_eq!(
            Path::new(&path).parent().unwrap(),
            home.join(COMPOSER_PASTES_DIRNAME)
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), "pasted body");
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn decode_clipboard_rejects_non_png() {
        assert!(decode_clipboard_image_base64("not-png").is_none());
        let png = {
            let mut v = PNG_SIGNATURE.to_vec();
            v.extend_from_slice(&[0, 1, 2, 3]);
            base64::engine::general_purpose::STANDARD.encode(&v)
        };
        assert!(decode_clipboard_image_base64(&png).is_some());
    }

    #[test]
    fn encode_powershell_is_utf16le_base64() {
        let encoded = encode_powershell_command("hi");
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .unwrap();
        assert_eq!(bytes, [b'h', 0, b'i', 0]);
    }

    fn tempfile_dir(prefix: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("{prefix}{}", random_hex3()));
        let _ = fs::create_dir_all(&path);
        path
    }
}
