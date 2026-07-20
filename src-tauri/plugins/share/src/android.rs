use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::models::ShareFileArgs;

const PLUGIN_IDENTIFIER: &str = "com.madsbuch.tally.share";

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<Share<R>> {
    let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "SharePlugin")?;
    Ok(Share(handle))
}

/// Access to the Android share sheet.
pub struct Share<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> Share<R> {
    pub fn share_file(&self, args: ShareFileArgs) -> crate::Result<()> {
        self.0
            .run_mobile_plugin::<serde_json::Value>("shareFile", args)?;
        Ok(())
    }
}
