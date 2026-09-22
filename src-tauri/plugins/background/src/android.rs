use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::models::BeginTaskArgs;

const PLUGIN_IDENTIFIER: &str = "com.madsbuch.tally.background";

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<Background<R>> {
    let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "BackgroundPlugin")?;
    Ok(Background(handle))
}

/// Access to the Android foreground service that keeps the process running.
pub struct Background<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> Background<R> {
    pub fn begin_task(&self, args: BeginTaskArgs) -> crate::Result<()> {
        self.0
            .run_mobile_plugin::<serde_json::Value>("beginTask", args)?;
        Ok(())
    }

    pub fn end_task(&self) -> crate::Result<()> {
        self.0
            .run_mobile_plugin::<serde_json::Value>("endTask", ())?;
        Ok(())
    }
}
