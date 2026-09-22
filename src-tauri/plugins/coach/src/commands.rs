use tauri::{command, AppHandle, Manager, Runtime};

use crate::models::ScheduleCheckinArgs;
use crate::CoachExt;
use crate::{Error, Result};

/// Where tauri-plugin-sql keeps `sqlite:tally.db`.
fn db_path<R: Runtime>(app: &AppHandle<R>) -> Result<String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| Error::Path(e.to_string()))?;
    Ok(dir.join("tally.db").to_string_lossy().into_owned())
}

#[command]
pub(crate) async fn schedule_checkin<R: Runtime>(
    app: AppHandle<R>,
    hour: i32,
    minute: i32,
) -> Result<()> {
    let db_path = db_path(&app)?;
    app.coach().schedule_checkin(ScheduleCheckinArgs {
        hour,
        minute,
        db_path,
    })
}

#[command]
pub(crate) async fn cancel_checkin<R: Runtime>(app: AppHandle<R>) -> Result<()> {
    app.coach().cancel_checkin()
}
