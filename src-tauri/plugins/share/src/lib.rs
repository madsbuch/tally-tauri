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
use android::Share;
#[cfg(not(target_os = "android"))]
use noop::Share;

/// Extension trait to access the share plugin from any Manager.
pub trait ShareExt<R: Runtime> {
    fn share(&self) -> &Share<R>;
}

impl<R: Runtime, T: Manager<R>> ShareExt<R> for T {
    fn share(&self) -> &Share<R> {
        self.state::<Share<R>>().inner()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("share")
        .invoke_handler(tauri::generate_handler![commands::share_file])
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            let share = android::init(app, api)?;
            #[cfg(not(target_os = "android"))]
            let share = noop::init(app, api)?;
            app.manage(share);
            Ok(())
        })
        .build()
}
