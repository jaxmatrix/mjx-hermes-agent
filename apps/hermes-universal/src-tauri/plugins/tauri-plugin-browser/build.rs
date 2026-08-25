const COMMANDS: &[&str] = &[
    "open",
    "navigate",
    "back",
    "forward",
    "reload",
    "stop",
    "set_bounds",
    "set_visible",
    "eval",
    "clear_data",
    "close",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .ios_path("ios")
        .build();
}
