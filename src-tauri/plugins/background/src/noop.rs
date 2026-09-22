use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::models::BeginTaskArgs;

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<Background<R>> {
    Ok(Background(std::marker::PhantomData))
}

/// No-op for desktop and iOS: only Android freezes a backgrounded process,
/// so only Android needs a foreground service to keep the work running.
pub struct Background<R: Runtime>(std::marker::PhantomData<fn() -> R>);

impl<R: Runtime> Background<R> {
    pub fn begin_task(&self, _args: BeginTaskArgs) -> crate::Result<()> {
        Ok(())
    }

    pub fn end_task(&self) -> crate::Result<()> {
        Ok(())
    }
}
