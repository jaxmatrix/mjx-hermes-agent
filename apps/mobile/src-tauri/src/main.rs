// Desktop dev entrypoint. On Android the app is launched through the generated
// mobile entry (lib.rs `run()` + the `mobile_entry_point` macro), not this.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    hermes_mobile_lib::run()
}
