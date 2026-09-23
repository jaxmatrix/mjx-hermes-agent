fn main() {
    #[cfg(all(target_os = "linux", not(target_os = "android")))]
    build_hud_modifier_linux();

    tauri_build::build();
}

/// Host-build the X11 helper Electron ships as `hud-modifier-monitor` (JSON-lines).
#[cfg(all(target_os = "linux", not(target_os = "android")))]
fn build_hud_modifier_linux() {
    use std::path::PathBuf;
    use std::process::Command;

    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let src = manifest.join("native/hud-modifier/hud-modifier-monitor-x11.c");
    let out = manifest.join("native/hud-modifier/hud-modifier-monitor");
    if !src.is_file() {
        return;
    }

    println!("cargo:rerun-if-changed={}", src.display());
    println!(
        "cargo:rerun-if-changed={}",
        manifest
            .join("native/hud-modifier/hud-modifier-gesture.h")
            .display()
    );

    let status = Command::new(std::env::var("CC").unwrap_or_else(|_| "cc".into()))
        .args([
            "-std=gnu11",
            "-O2",
            "-Wall",
            "-Wextra",
            src.to_str().unwrap(),
            "-o",
            out.to_str().unwrap(),
            "-lX11",
            "-lXi",
        ])
        .status();

    match status {
        Ok(s) if s.success() => {
            println!(
                "cargo:rustc-env=HERMES_HUD_MODIFIER_BUILT={}",
                out.display()
            );
        }
        Ok(_) | Err(_) => {
            eprintln!(
                "cargo:warning=hud-modifier helper not built (need libx11-dev + libxi-dev); gesture stays unavailable"
            );
        }
    }
}
