import { useEffect, useState } from "react";
import { setWorkoutCardio } from "../lib/db";
import { zone2Share } from "../lib/exerciseGoals";
import { garminDetailsForWorkouts } from "../lib/garminDb";
import { getCardioZone2Share } from "../lib/goals";
import type { Workout } from "../lib/types";

/**
 * Whether this workout counts toward the cardio goal — the user's call, per
 * workout. Until they make it, a Garmin activity mostly in Zone 2 makes it for
 * them (applyZone2Cardio); the help line says when that's what happened.
 */
export default function WorkoutCardioToggle({ workout, onSaved }: {
  workout: Workout;
  onSaved: () => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Zone 2 share (percent) of the attached Garmin activity, and the rule's bar. */
  const [zone2, setZone2] = useState<{ pct: number; bar: number | null } | null>(null);
  const checked = workout.cardio;
  const minutes = workout.duration_min != null && workout.duration_min > 0 ? workout.duration_min : null;
  const auto = !workout.cardio_by_hand;

  useEffect(() => {
    if (!auto || !workout.source) {
      setZone2(null);
      return;
    }
    let live = true;
    void Promise.all([garminDetailsForWorkouts([workout.id]), getCardioZone2Share()])
      .then(([details, bar]) => {
        const share = zone2Share(details.get(workout.id)?.zoneSecs);
        if (live) setZone2(share == null ? null : { pct: Math.round(share * 100), bar });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [workout.id, workout.source, auto]);

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

  const why = auto && zone2 && zone2.bar != null
    ? checked
      ? ` · on by itself: ${zone2.pct}% of it in Zone 2`
      : ` · ${zone2.pct}% in Zone 2, under the ${zone2.bar}% that counts by itself`
    : "";

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
              : (checked
                  ? minutes != null
                    ? `${Math.round(minutes)} min count toward your cardio goal`
                    : "Counts toward your cardio goal once it has a duration"
                  : "Off · not counted toward your cardio goal") + why}
          </span>
        </span>
        <span className={`zone2-switch${checked ? " zone2-switch-on" : ""}`} aria-hidden="true"><span /></span>
      </button>
      {error && <p className="error-text small" role="alert">{error}</p>}
    </div>
  );
}
