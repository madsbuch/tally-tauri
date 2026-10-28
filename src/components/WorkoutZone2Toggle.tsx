import { useState } from "react";
import { setWorkoutZone2 } from "../lib/db";
import { diaryZone2Minutes } from "../lib/exerciseGoals";
import type { Workout } from "../lib/types";

export default function WorkoutZone2Toggle({ workout, onSaved }: {
  workout: Workout;
  onSaved: () => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const minutes = diaryZone2Minutes(workout) ?? 0;
  const checked = minutes > 0;
  const hasDuration = workout.duration_min != null && workout.duration_min > 0;

  async function toggle() {
    setSaving(true);
    setError(null);
    try {
      await setWorkoutZone2(workout.id, !checked);
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <button
        className="info-row zone2-toggle"
        role="switch"
        aria-checked={checked}
        aria-label="Zone 2 workout"
        aria-describedby={`zone2-help-${workout.id}`}
        disabled={saving || (!checked && !hasDuration)}
        onClick={() => void toggle()}
      >
        <span>
          <span className="zone2-toggle-label">Zone 2 workout</span>
          <span id={`zone2-help-${workout.id}`} className="small muted zone2-toggle-help">
            {saving ? "Saving…" : checked
              ? `${minutes.toLocaleString(undefined, { maximumFractionDigits: 1 })} min counted toward your goal`
              : hasDuration ? "Off · Not counted toward your goal" : "Add a duration to count this workout"}
          </span>
        </span>
        <span className={`zone2-switch${checked ? " zone2-switch-on" : ""}`} aria-hidden="true"><span /></span>
      </button>
      {error && <p className="error-text small" role="alert">{error}</p>}
    </div>
  );
}
