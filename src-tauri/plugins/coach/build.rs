const COMMANDS: &[&str] = &["schedule_checkin", "cancel_checkin"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
