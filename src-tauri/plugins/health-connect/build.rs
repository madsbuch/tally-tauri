const COMMANDS: &[&str] = &[
    "get_status",
    "request_permissions",
    "read_exercise_sessions",
    "open_settings",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
