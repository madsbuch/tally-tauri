const COMMANDS: &[&str] = &[
    "schedule_checkin",
    "cancel_checkin",
    "take_opened_checkin",
    "notify_checkin",
    // Handled by the Kotlin plugin's base class: they let the app hear about
    // a check-in tapped while it was already running (`checkinOpened`).
    "register_listener",
    "remove_listener",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
