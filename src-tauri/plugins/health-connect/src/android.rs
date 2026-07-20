use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::models::{
    HealthConnectStatus, PermissionResponse, ReadSessionsArgs, SessionsResponse,
};

const PLUGIN_IDENTIFIER: &str = "com.madsbuch.tally.healthconnect";

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<HealthConnect<R>> {
    let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "HealthConnectPlugin")?;
    Ok(HealthConnect(handle))
}

/// Access to Android Health Connect (exercise sessions written by e.g. Garmin).
pub struct HealthConnect<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> HealthConnect<R> {
    pub fn get_status(&self) -> crate::Result<HealthConnectStatus> {
        Ok(self.0.run_mobile_plugin("getStatus", ())?)
    }

    pub fn request_permissions(&self) -> crate::Result<PermissionResponse> {
        Ok(self.0.run_mobile_plugin("requestHealthPermissions", ())?)
    }

    pub fn read_exercise_sessions(
        &self,
        args: ReadSessionsArgs,
    ) -> crate::Result<SessionsResponse> {
        Ok(self.0.run_mobile_plugin("readExerciseSessions", args)?)
    }

    pub fn open_settings(&self) -> crate::Result<()> {
        self.0
            .run_mobile_plugin::<serde_json::Value>("openSettings", ())?;
        Ok(())
    }
}
