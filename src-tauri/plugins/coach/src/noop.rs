use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::models::ScheduleCheckinArgs;

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<Coach<R>> {
    Ok(Coach(std::marker::PhantomData))
}

/// No-op for desktop and iOS. Only Android has the alarm, and only Android
/// needs one — elsewhere the app evaluates check-ins while it is running.
pub struct Coach<R: Runtime>(std::marker::PhantomData<fn() -> R>);

impl<R: Runtime> Coach<R> {
    pub fn schedule_checkin(&self, _args: ScheduleCheckinArgs) -> crate::Result<()> {
        Ok(())
    }

    pub fn cancel_checkin(&self) -> crate::Result<()> {
        Ok(())
    }
}
