use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::models::ScheduleCheckinArgs;

const PLUGIN_IDENTIFIER: &str = "com.madsbuch.tally.coach";

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<Coach<R>> {
    let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "CoachPlugin")?;
    Ok(Coach(handle))
}

/// Access to the Android alarm that runs the daily check-in.
pub struct Coach<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> Coach<R> {
    pub fn schedule_checkin(&self, args: ScheduleCheckinArgs) -> crate::Result<()> {
        self.0
            .run_mobile_plugin::<serde_json::Value>("scheduleCheckin", args)?;
        Ok(())
    }

    pub fn cancel_checkin(&self) -> crate::Result<()> {
        self.0
            .run_mobile_plugin::<serde_json::Value>("cancelCheckin", ())?;
        Ok(())
    }
}
