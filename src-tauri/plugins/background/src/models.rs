use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeginTaskArgs {
    /// One short line for the notification, e.g. "Analyzing your capture".
    pub label: String,
}
