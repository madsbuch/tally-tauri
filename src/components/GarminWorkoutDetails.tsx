import { useEffect, useState } from "react";
import { garminDetailsForWorkouts } from "../lib/garminDb";
import type { GarminWorkoutDetail } from "../lib/garminDb";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="info-row info-row-static">
      <span className="info-label">{label}</span>
      <span className="info-value">{value}</span>
    </div>
  );
}

const min = (sec: number) => `${Math.round(sec / 60)} min`;

function pace(mps: number, typeKey: string | null): string {
  // Runs and walks read as pace, everything else as speed.
  if (typeKey && /run|walk|hik/.test(typeKey) && mps > 0) {
    const secPerKm = 1000 / mps;
    const m = Math.floor(secPerKm / 60);
    const s = Math.round(secPerKm % 60);
    return `${m}:${String(s).padStart(2, "0")} /km`;
  }
  return `${(mps * 3.6).toFixed(1)} km/h`;
}

/**
 * What the direct Garmin Connect sync knows about this workout beyond what
 * Health Connect carried — nothing renders when it has nothing.
 */
export default function GarminWorkoutDetails({ workoutId }: { workoutId: number }) {
  const [d, setD] = useState<GarminWorkoutDetail | null>(null);

  useEffect(() => {
    let live = true;
    garminDetailsForWorkouts([workoutId])
      .then((m) => {
        if (live) setD(m.get(workoutId) ?? null);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [workoutId]);

  if (!d) return null;
  const rows: { label: string; value: string }[] = [];
  if (d.aerobicTe != null || d.anaerobicTe != null) {
    rows.push({
      label: "Training Effect",
      value:
        `${d.aerobicTe?.toFixed(1) ?? "–"} aerobic · ${d.anaerobicTe?.toFixed(1) ?? "–"} anaerobic` +
        (d.teLabel ? ` · ${d.teLabel.toLowerCase().replace(/_/g, " ")}` : ""),
    });
  }
  if (d.trainingLoad != null) rows.push({ label: "Training load", value: String(Math.round(d.trainingLoad)) });
  if (d.avgHr != null) {
    rows.push({
      label: "Heart rate",
      value: `avg ${Math.round(d.avgHr)}${d.maxHr != null ? ` · max ${Math.round(d.maxHr)}` : ""}`,
    });
  }
  if (d.zoneSecs) {
    rows.push({
      label: "HR zones",
      value: d.zoneSecs.map((s, i) => `Z${i + 1} ${Math.round(s / 60)}`).join(" · ") + " min",
    });
  }
  if (d.distanceM != null && d.distanceM >= 100) {
    rows.push({ label: "Distance", value: `${(d.distanceM / 1000).toFixed(2)} km` });
  }
  if (d.avgSpeedMps != null && d.avgSpeedMps > 0) {
    rows.push({ label: "Pace", value: pace(d.avgSpeedMps, d.typeKey) });
  }
  if (d.avgPower != null) {
    rows.push({
      label: "Power",
      value: `avg ${Math.round(d.avgPower)} W${d.normPower != null ? ` · NP ${Math.round(d.normPower)} W` : ""}`,
    });
  }
  if (d.avgCadence != null) rows.push({ label: "Cadence", value: String(Math.round(d.avgCadence)) });
  if (d.elevationGainM != null && d.elevationGainM > 0) {
    rows.push({ label: "Elevation gain", value: `${Math.round(d.elevationGainM)} m` });
  }
  if (d.vo2Max != null) rows.push({ label: "VO2 max", value: String(d.vo2Max) });
  if (rows.length === 0 && !d.laps?.length) return null;

  return (
    <>
      <div className="section-title">From Garmin Connect</div>
      <div className="list">
        {rows.map((r) => (
          <Row key={r.label} label={r.label} value={r.value} />
        ))}
      </div>
      {d.laps && d.laps.length > 1 && (
        <>
          <div className="section-title">Laps</div>
          <div className="list">
            {d.laps.map((l) => (
              <Row
                key={l.index}
                label={`Lap ${l.index}`}
                value={[
                  l.distanceM != null && l.distanceM > 0 ? `${(l.distanceM / 1000).toFixed(2)} km` : null,
                  l.durationSec != null ? min(l.durationSec) : null,
                  l.avgSpeedMps != null && l.avgSpeedMps > 0 ? pace(l.avgSpeedMps, d.typeKey) : null,
                  l.avgHr != null ? `${Math.round(l.avgHr)} bpm` : null,
                  l.avgPower != null ? `${Math.round(l.avgPower)} W` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              />
            ))}
          </div>
        </>
      )}
    </>
  );
}
