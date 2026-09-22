use tauri::{command, AppHandle, Runtime};

use crate::models::BeginTaskArgs;
use crate::BackgroundExt;
use crate::Result;

#[command]
pub(crate) async fn begin_task<R: Runtime>(app: AppHandle<R>, label: String) -> Result<()> {
    app.background().begin_task(BeginTaskArgs { label })
}

#[command]
pub(crate) async fn end_task<R: Runtime>(app: AppHandle<R>) -> Result<()> {
    app.background().end_task()
}
