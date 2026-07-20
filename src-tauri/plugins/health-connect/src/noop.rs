use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::models::{
    HealthConnectStatus, PermissionResponse, ReadSessionsArgs, SessionsResponse,
};

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<HealthConnect<R>> {
    Ok(HealthConnect(std::marker::PhantomData))
}

/// No-op implementation for desktop and iOS — Health Connect is Android-only.
pub struct HealthConnect<R: Runtime>(std::marker::PhantomData<fn() -> R>);

impl<R: Runtime> HealthConnect<R> {
    pub fn get_status(&self) -> crate::Result<HealthConnectStatus> {
        Ok(HealthConnectStatus {
            availability: "unavailable".into(),
            permissions_granted: false,
        })
    }

    pub fn request_permissions(&self) -> crate::Result<PermissionResponse> {
        Ok(PermissionResponse { granted: false })
    }

    pub fn read_exercise_sessions(
        &self,
        _args: ReadSessionsArgs,
    ) -> crate::Result<SessionsResponse> {
        Ok(SessionsResponse { sessions: vec![] })
    }

    pub fn open_settings(&self) -> crate::Result<()> {
        Ok(())
    }
}
