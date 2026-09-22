//! Keeps Tally's process alive while AI work is in flight.
//!
//! Android freezes (and eventually kills) a backgrounded app's process, which
//! is what dropped an in-flight OpenRouter request the moment the user
//! switched away mid-answer. A foreground service moves the process into the
//! foreground importance class for as long as the work lasts, so the request
//! finishes and the diary entry lands even with the app closed.
//!
//! The service holds no state of its own: the frontend begins a task before
//! starting AI work and ends it in a `finally`, ref-counted in
//! `src/lib/background.ts`.

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
use android::Background;
#[cfg(not(target_os = "android"))]
use noop::Background;

/// Extension trait to access the background plugin from any Manager.
pub trait BackgroundExt<R: Runtime> {
    fn background(&self) -> &Background<R>;
}

impl<R: Runtime, T: Manager<R>> BackgroundExt<R> for T {
    fn background(&self) -> &Background<R> {
        self.state::<Background<R>>().inner()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("background")
        .invoke_handler(tauri::generate_handler![
            commands::begin_task,
            commands::end_task
        ])
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            let background = android::init(app, api)?;
            #[cfg(not(target_os = "android"))]
            let background = noop::init(app, api)?;
            app.manage(background);
            Ok(())
        })
        .build()
}
