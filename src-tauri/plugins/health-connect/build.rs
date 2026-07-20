const COMMANDS: &[&str] = &[
    "get_status",
    "request_permissions",
    "revoke_permissions",
    "read_exercise_sessions",
    "read_sleep_sessions",
    "read_daily_metrics",
    "open_settings",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
