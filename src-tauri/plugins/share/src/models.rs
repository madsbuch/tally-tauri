use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareFileArgs {
    /// Absolute path of the file to share.
    pub path: String,
    /// MIME type, e.g. "application/octet-stream".
    pub mime: String,
    /// Title for the share-sheet chooser.
    pub title: String,
}
