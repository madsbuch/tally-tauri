use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::models::ShareFileArgs;

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<Share<R>> {
    Ok(Share(std::marker::PhantomData))
}

/// No-op implementation — the share sheet only exists on Android. Desktop
/// callers show the exported file's path instead of invoking this.
pub struct Share<R: Runtime>(std::marker::PhantomData<fn() -> R>);

impl<R: Runtime> Share<R> {
    pub fn share_file(&self, _args: ShareFileArgs) -> crate::Result<()> {
        Ok(())
    }
}
