use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthConnectStatus {
    /// "available" | "updateRequired" | "unavailable"
    pub availability: String,
    /// Whether every read permission the plugin needs has been granted.
    pub permissions_granted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionResponse {
    pub granted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadSessionsArgs {
    /// Unix epoch milliseconds — inclusive start of the query window.
    pub start_ms: i64,
    /// Unix epoch milliseconds — exclusive end of the query window.
    pub end_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExerciseSession {
    /// Health Connect record UID — stable across re-reads, used for dedup.
    pub id: String,
    #[serde(default)]
    pub title: Option<String>,
    /// Human-readable activity kind, e.g. "Running".
    pub exercise_type: String,
    pub start_ms: i64,
    pub end_ms: i64,
    /// Active calories burned during the session (kcal), if recorded.
    #[serde(default)]
    pub calories: Option<f64>,
    #[serde(default)]
    pub distance_meters: Option<f64>,
    #[serde(default)]
    pub avg_heart_rate: Option<f64>,
    /// Package name of the app that wrote the record (e.g. Garmin Connect).
    #[serde(default)]
    pub source_package: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionsResponse {
    pub sessions: Vec<ExerciseSession>,
}
