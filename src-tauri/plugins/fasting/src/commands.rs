use tauri::{command, AppHandle, Runtime};

use crate::models::StartCountdownArgs;
use crate::FastingExt;
use crate::Result;

#[command]
pub(crate) async fn start_countdown<R: Runtime>(
    app: AppHandle<R>,
    end_at_ms: i64,
    title: String,
    body: String,
) -> Result<()> {
    app.fasting().start_countdown(StartCountdownArgs {
        end_at_ms,
        title,
        body,
    })
}

#[command]
pub(crate) async fn stop_countdown<R: Runtime>(app: AppHandle<R>) -> Result<()> {
    app.fasting().stop_countdown()
}
