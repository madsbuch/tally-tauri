//! Laps out of an activity's original FIT file — the one place the Personal
//! API carries them (`/download-service/files/activity/{id}`, served zipped).

use std::io::{Cursor, Read};

use fitparser::profile::MesgNum;
use fitparser::Value;
use serde::Serialize;

use crate::{GarminError, Result};

/// One lap, in the shape the app stores (`garmin_activities.laps`).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Lap {
    pub index: u32,
    pub start_ms: Option<i64>,
    pub duration_sec: Option<f64>,
    pub distance_m: Option<f64>,
    pub avg_hr: Option<f64>,
    pub max_hr: Option<f64>,
    pub avg_speed_mps: Option<f64>,
    pub avg_power: Option<f64>,
    pub avg_cadence: Option<f64>,
    pub elevation_gain_m: Option<f64>,
    pub calories: Option<f64>,
}

/// The FIT bytes: unzipped when Garmin zipped them (it does), as-is otherwise.
fn fit_bytes(data: &[u8]) -> Result<Vec<u8>> {
    if !data.starts_with(b"PK") {
        return Ok(data.to_vec());
    }
    let mut zip = zip::ZipArchive::new(Cursor::new(data))
        .map_err(|e| GarminError::Unexpected(format!("activity zip: {e}")))?;
    for i in 0..zip.len() {
        let mut f = zip
            .by_index(i)
            .map_err(|e| GarminError::Unexpected(format!("activity zip: {e}")))?;
        if f.name().to_ascii_lowercase().ends_with(".fit") {
            let mut out = Vec::with_capacity(f.size() as usize);
            f.read_to_end(&mut out)
                .map_err(|e| GarminError::Unexpected(format!("activity zip: {e}")))?;
            return Ok(out);
        }
    }
    Err(GarminError::Unexpected("no .fit file in the activity download".into()))
}

fn num(v: &Value) -> Option<f64> {
    let n = match v {
        Value::Byte(x) | Value::Enum(x) | Value::UInt8(x) | Value::UInt8z(x) => *x as f64,
        Value::SInt8(x) => *x as f64,
        Value::SInt16(x) => *x as f64,
        Value::UInt16(x) | Value::UInt16z(x) => *x as f64,
        Value::SInt32(x) => *x as f64,
        Value::UInt32(x) | Value::UInt32z(x) => *x as f64,
        Value::SInt64(x) => *x as f64,
        Value::UInt64(x) | Value::UInt64z(x) => *x as f64,
        Value::Float32(x) => *x as f64,
        Value::Float64(x) => *x,
        _ => return None,
    };
    n.is_finite().then_some(n)
}

/// Laps in recorded order. Running cadence is stored per leg in FIT; it's
/// doubled to steps per minute, the number Garmin Connect shows.
pub fn laps(data: &[u8]) -> Result<Vec<Lap>> {
    let bytes = fit_bytes(data)?;
    let records = fitparser::from_bytes(&bytes)
        .map_err(|e| GarminError::Unexpected(format!("FIT: {e}")))?;

    let running = records.iter().any(|r| {
        r.kind() == MesgNum::Session
            && r.fields().iter().any(|f| {
                f.name() == "sport"
                    && matches!(f.value(), Value::String(s) if s == "running" || s == "walking")
            })
    });

    let mut out = Vec::new();
    for r in records.iter().filter(|r| r.kind() == MesgNum::Lap) {
        let get = |names: &[&str]| {
            names.iter().find_map(|n| {
                r.fields().iter().find(|f| f.name() == *n).and_then(|f| num(f.value()))
            })
        };
        let start_ms = r.fields().iter().find(|f| f.name() == "start_time").and_then(|f| {
            match f.value() {
                Value::Timestamp(t) => Some(t.timestamp_millis()),
                _ => None,
            }
        });
        let cadence = get(&["avg_running_cadence", "avg_cadence"]);
        out.push(Lap {
            index: out.len() as u32 + 1,
            start_ms,
            duration_sec: get(&["total_timer_time", "total_elapsed_time"]),
            distance_m: get(&["total_distance"]),
            avg_hr: get(&["avg_heart_rate"]),
            max_hr: get(&["max_heart_rate"]),
            avg_speed_mps: get(&["enhanced_avg_speed", "avg_speed"]),
            avg_power: get(&["avg_power"]),
            avg_cadence: cadence.map(|c| if running { c * 2.0 } else { c }),
            elevation_gain_m: get(&["total_ascent"]),
            calories: get(&["total_calories"]),
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_garbage_cleanly() {
        assert!(laps(b"not a fit file").is_err());
        assert!(laps(b"PK\x03\x04garbage").is_err());
    }
}

#[cfg(test)]
mod fixture_tests {
    use super::*;

    /// A real Garmin (fēnix 5) ride, from the fitparser crate's fixtures.
    #[test]
    fn reads_laps_from_a_real_activity() {
        let data = include_bytes!("../tests/fixtures/garmin-fenix-5-bike.fit");
        let laps = laps(data).expect("parses");
        assert!(!laps.is_empty());
        let first = &laps[0];
        assert_eq!(first.index, 1);
        assert!(first.start_ms.is_some());
        assert!(first.duration_sec.unwrap_or(0.0) > 0.0);
        println!("{} laps, first: {:?}", laps.len(), first);

        // Zipped the way Garmin serves it, it reads the same.
        let mut zipped = Vec::new();
        {
            let mut w = zip::ZipWriter::new(std::io::Cursor::new(&mut zipped));
            w.start_file::<_, ()>("123_ACTIVITY.fit", zip::write::FileOptions::default()).unwrap();
            std::io::Write::write_all(&mut w, data).unwrap();
            w.finish().unwrap();
        }
        assert_eq!(super::laps(&zipped).expect("zip parses"), laps);
    }
}
