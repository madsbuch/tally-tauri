use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::models::StartCountdownArgs;

const PLUGIN_IDENTIFIER: &str = "com.madsbuch.tally.fasting";

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<Fasting<R>> {
    let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "FastingPlugin")?;
    Ok(Fasting(handle))
}

/// Access to the Android chronometer-countdown notification.
pub struct Fasting<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> Fasting<R> {
    pub fn start_countdown(&self, args: StartCountdownArgs) -> crate::Result<()> {
        self.0
            .run_mobile_plugin::<serde_json::Value>("startCountdown", args)?;
        Ok(())
    }

    pub fn stop_countdown(&self) -> crate::Result<()> {
        self.0
            .run_mobile_plugin::<serde_json::Value>("stopCountdown", ())?;
        Ok(())
    }
}
