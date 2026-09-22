use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleCheckinArgs {
    /// Local hour, 0-23, the daily check-in wakes up at.
    pub hour: i32,
    /// Local minute, 0-59.
    pub minute: i32,
    /// Absolute path to the app's SQLite file.
    ///
    /// Resolved on the Rust side and handed over, rather than guessed in
    /// Kotlin: the worker has to open exactly the database tauri-plugin-sql
    /// writes, and only Tauri's own path resolver knows where that is.
    pub db_path: String,
}
