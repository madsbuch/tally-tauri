use tauri::{command, AppHandle, Runtime};

use crate::models::{
    DailyMetricsResponse, HealthConnectStatus, PermissionResponse, ReadSessionsArgs,
    SessionsResponse, SleepResponse,
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
pub(crate) async fn revoke_permissions<R: Runtime>(app: AppHandle<R>) -> Result<()> {
    app.health_connect().revoke_permissions()
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
pub(crate) async fn read_sleep_sessions<R: Runtime>(
    app: AppHandle<R>,
    start_ms: i64,
    end_ms: i64,
) -> Result<SleepResponse> {
    app.health_connect()
        .read_sleep_sessions(ReadSessionsArgs { start_ms, end_ms })
}

#[command]
pub(crate) async fn read_daily_metrics<R: Runtime>(
    app: AppHandle<R>,
    start_ms: i64,
    end_ms: i64,
) -> Result<DailyMetricsResponse> {
    app.health_connect()
        .read_daily_metrics(ReadSessionsArgs { start_ms, end_ms })
}

#[command]
pub(crate) async fn open_settings<R: Runtime>(app: AppHandle<R>) -> Result<()> {
    app.health_connect().open_settings()
}
