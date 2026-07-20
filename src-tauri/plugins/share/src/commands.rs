use tauri::{command, AppHandle, Runtime};

use crate::models::ShareFileArgs;
use crate::Result;
use crate::ShareExt;

#[command]
pub(crate) async fn share_file<R: Runtime>(
    app: AppHandle<R>,
    path: String,
    mime: String,
    title: String,
) -> Result<()> {
    app.share().share_file(ShareFileArgs { path, mime, title })
}
