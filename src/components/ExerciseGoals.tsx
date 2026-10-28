import { useEffect, useState } from "react";
import { getSetting, setSetting, listWorkoutsForRange, todayStr } from "../lib/db";
import { onDiaryChanged } from "../lib/agent";
import { onAppResume } from "../lib/appLifecycle";
import { shiftDay } from "../lib/daystamp";
import { DEFAULT_ZONE2_TARGET, exerciseProgress } from "../lib/exerciseGoals";
import { useGo } from "../lib/navigation";
import { SETTING_KEYS } from "../lib/types";
import type { Workout } from "../lib/types";

/** Exercise targets always cover today and the preceding six local diary days. */
export default function ExerciseGoals() {
  const go = useGo();
  const [workouts, setWorkouts] = useState<Workout[] | null>(null);
  const [target, setTarget] = useState(DEFAULT_ZONE2_TARGET);
  const [draft, setDraft] = useState("");
  const [reload, setReload] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const end = todayStr();
  const start = shiftDay(end, -6);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      listWorkoutsForRange(start, end),
      getSetting(SETTING_KEYS.zone2WeeklyTarget),
    ]).then(([rows, raw]) => {
      if (cancelled) return;
      const n = Number(raw);
      const goal = Number.isFinite(n) && n >= 1 && n <= 10080 ? n : DEFAULT_ZONE2_TARGET;
      setWorkouts(rows);
      setTarget(goal);
      setError(null);
    }).catch((e: unknown) => {
      if (!cancelled) setError(e instanceof Error ? e.message : String(e));
    });
    return () => { cancelled = true; };
  }, [start, end, reload]);

  useEffect(() => {
    const refresh = () => setReload((n) => n + 1);
    const offDiary = onDiaryChanged(refresh);
    const offResume = onAppResume(refresh);
    // Refresh through midnight even while Summary stays in the foreground.
    const timer = window.setInterval(refresh, 60_000);
    return () => { offDiary(); offResume(); window.clearInterval(timer); };
  }, []);

  async function saveTarget(e: React.FormEvent) {
    e.preventDefault();
    const n = Number(draft);
    if (!draft.trim() || !Number.isFinite(n) || n < 1 || n > 10080) {
      setSaveError("Enter a target between 1 and 10,080 minutes.");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await setSetting(SETTING_KEYS.zone2WeeklyTarget, String(n));
      setTarget(n);
      setDraft("");
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const progress = exerciseProgress(workouts ?? [], target);
  const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 1 });

  return (
    <section className="card exercise-goals" aria-label="Exercise goals">
      <div className="summary-section-heading">
        <h2 className="card-title" style={{ margin: 0 }}>Exercise goals</h2>
        <span className="faint small">Last 7 days</span>
      </div>
      {error ? (
        <div role="alert">
          <p className="error-text">{error}</p>
          <button className="btn btn-sm" onClick={() => setReload((n) => n + 1)}>Retry</button>
        </div>
      ) : workouts == null ? <p className="muted small">Loading exercise…</p> : (
        <details className="summary-details exercise-goal-details">
          <summary>
            <div className="summary-section-heading">
              <strong>Zone 2</strong>
              <span>{fmt(progress.minutes)} / {fmt(target)} min</span>
            </div>
            <div className="exercise-meter" role="progressbar" aria-label="Zone 2 goal" aria-valuenow={Math.min(target, progress.minutes)} aria-valuemin={0} aria-valuemax={target} aria-valuetext={`${fmt(progress.minutes)} of ${fmt(target)} minutes`}>
              <div style={{ width: `${progress.percent}%` }} />
            </div>
            <div className="summary-section-heading small muted">
              <span>{progress.remaining > 0 ? `${fmt(progress.remaining)} min remaining` : "Goal reached"}</span>
              <span className="faint">Details &amp; target</span>
            </div>
          </summary>
          <p className="faint small">{start} – {end} · Today and the previous six days. Only explicitly recorded Zone 2 minutes count.</p>
          {progress.unknown > 0 && <p className="muted small">{progress.unknown} workout{progress.unknown === 1 ? " has" : "s have"} no Zone 2 minutes recorded. Tap a workout to add them.</p>}
          {workouts.length === 0 ? <p className="muted small">Log a workout in the Diary to get started.</p> : (
            <div className="list">
              {workouts.map((w) => (
                <button key={w.id} className="exercise-workout" onClick={() => go(`/entry/workout/${w.id}`)}>
                  <span><strong>{w.title}</strong><span className="faint small">{w.day}</span></span>
                  <span className="muted small">{w.zone2_min == null ? "Add Zone 2" : `${fmt(w.zone2_min)} min`}</span>
                </button>
              ))}
            </div>
          )}
          <form onSubmit={(e) => void saveTarget(e)} style={{ marginTop: 16 }}>
            <label className="label" htmlFor="zone2-target">Target per 7 days (minutes)</label>
            <div className="btn-row">
              <input id="zone2-target" className="input" type="number" min="1" max="10080" step="any" placeholder={String(target)} value={draft} onChange={(e) => setDraft(e.target.value)} disabled={saving} />
              <button className="btn btn-sm" disabled={saving || !draft.trim()}>{saving ? "Saving…" : "Save"}</button>
            </div>
            {saveError && <p className="error-text" role="alert">{saveError}</p>}
          </form>
        </details>
      )}
    </section>
  );
}
