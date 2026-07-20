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
use android::Fasting;
#[cfg(not(target_os = "android"))]
use noop::Fasting;

/// Extension trait to access the fasting plugin from any Manager.
pub trait FastingExt<R: Runtime> {
    fn fasting(&self) -> &Fasting<R>;
}

impl<R: Runtime, T: Manager<R>> FastingExt<R> for T {
    fn fasting(&self) -> &Fasting<R> {
        self.state::<Fasting<R>>().inner()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("fasting")
        .invoke_handler(tauri::generate_handler![
            commands::start_countdown,
            commands::stop_countdown
        ])
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            let fasting = android::init(app, api)?;
            #[cfg(not(target_os = "android"))]
            let fasting = noop::init(app, api)?;
            app.manage(fasting);
            Ok(())
        })
        .build()
}
