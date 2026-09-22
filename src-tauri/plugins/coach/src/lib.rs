//! The daily coach check-in, scheduled so it runs with the app closed.
//!
//! This plugin only schedules. The check-in itself is done in Kotlin (see
//! `android/…/CoachWorker.kt`), for a structural reason: the alarm arrives in
//! Kotlin, and Tauri's mobile plugin bridge runs Rust → Kotlin, not back. A
//! Rust worker would need a JNI entry point of its own; a Kotlin one can open
//! the same SQLite file and get on with it.
//!
//! The parts that would otherwise be duplicated over there are avoided rather
//! than reimplemented: the frontend caches the clock-independent half of the
//! coach prompt into the settings table, and the worker appends only the
//! digest it computes itself.

use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

mod commands;
mod error;
mod models;

pub use error::{Error, Result};
pub use models::*;

#[cfg(target_os = "android")]
mod android;
#[cfg(not(target_os = "android"))]
mod noop;

#[cfg(target_os = "android")]
use android::Coach;
#[cfg(not(target_os = "android"))]
use noop::Coach;

/// Extension trait to access the coach plugin from any Manager.
pub trait CoachExt<R: Runtime> {
    fn coach(&self) -> &Coach<R>;
}

impl<R: Runtime, T: Manager<R>> CoachExt<R> for T {
    fn coach(&self) -> &Coach<R> {
        self.state::<Coach<R>>().inner()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("coach")
        .invoke_handler(tauri::generate_handler![
            commands::schedule_checkin,
            commands::cancel_checkin
        ])
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            let coach = android::init(app, api)?;
            #[cfg(not(target_os = "android"))]
            let coach = noop::init(app, api)?;
            app.manage(coach);
            Ok(())
        })
        .build()
}
