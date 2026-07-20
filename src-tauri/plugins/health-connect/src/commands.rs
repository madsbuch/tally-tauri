use tauri::{command, AppHandle, Runtime};

use crate::models::{
    HealthConnectStatus, PermissionResponse, ReadSessionsArgs, SessionsResponse,
};
use crate::HealthConnectExt;
use crate::Result;

#[command]
pub(crate) async fn get_status<R: Runtime>(app: AppHandle<R>) -> Result<HealthConnectStatus> {
    app.health_connect().get_status()
}

#[command]
pub(crate) async fn request_permissions<R: Runtime>(
    app: AppHandle<R>,
) -> Result<PermissionResponse> {
    app.health_connect().request_permissions()
}

#[command]
pub(crate) async fn read_exercise_sessions<R: Runtime>(
    app: AppHandle<R>,
    start_ms: i64,
    end_ms: i64,
) -> Result<SessionsResponse> {
    app.health_connect()
        .read_exercise_sessions(ReadSessionsArgs { start_ms, end_ms })
}

#[command]
pub(crate) async fn open_settings<R: Runtime>(app: AppHandle<R>) -> Result<()> {
    app.health_connect().open_settings()
}
