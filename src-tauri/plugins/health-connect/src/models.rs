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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SleepSession {
    /// Health Connect record UID — stable across re-reads, used for dedup.
    pub id: String,
    #[serde(default)]
    pub title: Option<String>,
    pub start_ms: i64,
    pub end_ms: i64,
    /// Stage minutes, when the source recorded sleep stages.
    #[serde(default)]
    pub deep_min: Option<f64>,
    #[serde(default)]
    pub rem_min: Option<f64>,
    #[serde(default)]
    pub light_min: Option<f64>,
    #[serde(default)]
    pub awake_min: Option<f64>,
    #[serde(default)]
    pub source_package: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SleepResponse {
    pub sessions: Vec<SleepSession>,
}

/// Per-local-day wellness aggregates. Fields are absent when nothing was
/// recorded (or the per-type permission wasn't granted).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyMetric {
    /// Local day "YYYY-MM-DD".
    pub day: String,
    #[serde(default)]
    pub steps: Option<i64>,
    /// Total energy burned that day (kcal).
    #[serde(default)]
    pub calories_total: Option<f64>,
    #[serde(default)]
    pub resting_hr: Option<f64>,
    /// Heart-rate variability, RMSSD in milliseconds.
    #[serde(default)]
    pub hrv_ms: Option<f64>,
    /// Blood oxygen saturation in percent.
    #[serde(default)]
    pub spo2_pct: Option<f64>,
    #[serde(default)]
    pub weight_kg: Option<f64>,
    #[serde(default)]
    pub vo2_max: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyMetricsResponse {
    pub days: Vec<DailyMetric>,
}
