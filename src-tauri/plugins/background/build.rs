const COMMANDS: &[&str] = &["begin_task", "end_task"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
