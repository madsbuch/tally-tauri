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
use android::HealthConnect;
#[cfg(not(target_os = "android"))]
use noop::HealthConnect;

/// Extension trait to access the health-connect plugin from any Manager.
pub trait HealthConnectExt<R: Runtime> {
    fn health_connect(&self) -> &HealthConnect<R>;
}

impl<R: Runtime, T: Manager<R>> HealthConnectExt<R> for T {
    fn health_connect(&self) -> &HealthConnect<R> {
        self.state::<HealthConnect<R>>().inner()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("health-connect")
        .invoke_handler(tauri::generate_handler![
            commands::get_status,
            commands::request_permissions,
            commands::read_exercise_sessions,
            commands::open_settings
        ])
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            let hc = android::init(app, api)?;
            #[cfg(not(target_os = "android"))]
            let hc = noop::init(app, api)?;
            app.manage(hc);
            Ok(())
        })
        .build()
}
