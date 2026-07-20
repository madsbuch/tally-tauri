use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::models::StartCountdownArgs;

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<Fasting<R>> {
    Ok(Fasting(std::marker::PhantomData))
}

/// No-op implementation for desktop and iOS — the sticky countdown
/// notification only exists on Android.
pub struct Fasting<R: Runtime>(std::marker::PhantomData<fn() -> R>);

impl<R: Runtime> Fasting<R> {
    pub fn start_countdown(&self, _args: StartCountdownArgs) -> crate::Result<()> {
        Ok(())
    }

    pub fn stop_countdown(&self) -> crate::Result<()> {
        Ok(())
    }
}
