import { useState } from "react";
import { setWorkoutCardio } from "../lib/db";
import type { Workout } from "../lib/types";

/** Whether this workout counts toward the cardio goal — the user's call, per workout. */
export default function WorkoutCardioToggle({ workout, onSaved }: {
  workout: Workout;
  onSaved: () => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const checked = workout.cardio;
  const minutes = workout.duration_min != null && workout.duration_min > 0 ? workout.duration_min : null;

  async function toggle() {
    setSaving(true);
    setError(null);
    try {
      await setWorkoutCardio(workout.id, !checked);
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
        aria-label="Cardio"
        aria-describedby={`cardio-help-${workout.id}`}
        disabled={saving}
        onClick={() => void toggle()}
      >
        <span>
          <span className="zone2-toggle-label">Cardio</span>
          <span id={`cardio-help-${workout.id}`} className="small muted zone2-toggle-help">
            {saving
              ? "Saving…"
              : checked
                ? minutes != null
                  ? `${Math.round(minutes)} min count toward your cardio goal`
                  : "Counts toward your cardio goal once it has a duration"
                : "Off · not counted toward your cardio goal"}
          </span>
        </span>
        <span className={`zone2-switch${checked ? " zone2-switch-on" : ""}`} aria-hidden="true"><span /></span>
      </button>
      {error && <p className="error-text small" role="alert">{error}</p>}
    </div>
  );
}
