use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartCountdownArgs {
    /// Unix epoch milliseconds at which the fast ends.
    pub end_at_ms: i64,
    /// Unix epoch milliseconds at which the fast started (for progress).
    pub start_at_ms: i64,
    pub title: String,
    pub body: String,
}
