import { useEffect, useState } from "react";
import { getSetting } from "../lib/db";
import { DEFAULT_ZONE2_TARGET, exerciseProgress, exerciseTarget } from "../lib/exerciseGoals";
import { SETTING_KEYS } from "../lib/types";
import type { Workout } from "../lib/types";

/**
 * A summary of the Zone 2 goal over the Summary range, from the same workout
 * rows its energy totals use. The target is a stored setting with no editor
 * here: it changes rarely, and on request.
 */
export default function ExerciseGoals({ workouts, days, label }: {
  workouts: Workout[];
  days: number;
  label: string;
}) {
  const [weeklyTarget, setWeeklyTarget] = useState<number | null>(null);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    getSetting(SETTING_KEYS.zone2WeeklyTarget).then((raw) => {
      if (cancelled) return;
      const n = Number(raw);
      setWeeklyTarget(Number.isFinite(n) && n >= 1 && n <= 10080 ? n : DEFAULT_ZONE2_TARGET);
      setError(null);
    }).catch((e: unknown) => {
      if (!cancelled) setError(e instanceof Error ? e.message : String(e));
    });
    return () => { cancelled = true; };
  }, [reload]);

  const target = exerciseTarget(weeklyTarget ?? DEFAULT_ZONE2_TARGET, days);
  const progress = exerciseProgress(workouts, target);
  const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 1 });

  return (
    <section className="card exercise-goals" aria-label="Exercise goals">
      <div className="summary-section-heading">
        <h2 className="card-title" style={{ margin: 0 }}>Exercise goals</h2>
        <span className="faint small">{label}</span>
      </div>
      {error ? (
        <div role="alert">
          <p className="error-text">{error}</p>
          <button className="btn btn-sm" onClick={() => setReload((n) => n + 1)}>Retry</button>
        </div>
      ) : weeklyTarget == null ? <p className="muted small">Loading exercise…</p> : (
        <div className="exercise-goal-body">
          <div className="summary-section-heading">
            <strong>Zone 2</strong>
            <span>{fmt(progress.minutes)} / {fmt(target)} min</span>
          </div>
          <div className="exercise-meter" role="progressbar" aria-label="Zone 2 goal" aria-valuenow={Math.min(target, progress.minutes)} aria-valuemin={0} aria-valuemax={target} aria-valuetext={`${fmt(progress.minutes)} of ${fmt(target)} minutes`}>
            <div style={{ width: `${progress.percent}%` }} />
          </div>
          <div className="small muted">
            {progress.remaining > 0 ? `${fmt(progress.remaining)} min remaining` : "Goal reached"}
          </div>
        </div>
      )}
    </section>
  );
}
