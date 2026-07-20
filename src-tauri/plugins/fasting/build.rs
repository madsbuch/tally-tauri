const COMMANDS: &[&str] = &["start_countdown", "stop_countdown"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
