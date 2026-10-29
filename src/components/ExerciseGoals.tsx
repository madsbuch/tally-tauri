import { useEffect, useState } from "react";
import { getSetting, setSetting } from "../lib/db";
import { DEFAULT_ZONE2_TARGET, exerciseProgress, exerciseTarget, diaryZone2Minutes } from "../lib/exerciseGoals";
import { useGo } from "../lib/navigation";
import { SETTING_KEYS } from "../lib/types";
import type { Workout } from "../lib/types";

/** Shares the Summary range and the exact workout rows used for its energy totals. */
export default function ExerciseGoals({ workouts, start, end, days, label }: {
  workouts: Workout[];
  start: string;
  end: string;
  days: number;
  label: string;
}) {
  const go = useGo();
  const [weeklyTarget, setWeeklyTarget] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [reload, setReload] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
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
      setWeeklyTarget(n);
      setDraft("");
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

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
          <p className="faint small">{start} – {end} · Automatically totals Zone 2 time from your diary, including the duration of workouts described as Zone 2.</p>
          {progress.unknown > 0 && <p className="muted small">{progress.unknown} diary workout{progress.unknown === 1 ? " has" : "s have"} no Zone 2 information.</p>}
          {workouts.length === 0 ? <p className="muted small">Log a workout in the Diary to get started.</p> : (
            <div className="list">
              {workouts.map((w) => (
                <button key={w.id} className="exercise-workout" onClick={() => go(`/entry/workout/${w.id}`)}>
                  <span><strong>{w.title}</strong><span className="faint small">{w.day}</span></span>
                  <span className="muted small">{diaryZone2Minutes(w) == null ? "No zone data" : `${fmt(diaryZone2Minutes(w)!)} min`}</span>
                </button>
              ))}
            </div>
          )}
          <form onSubmit={(e) => void saveTarget(e)} style={{ marginTop: 16 }}>
            <label className="label" htmlFor="zone2-target">Target per 7 days (minutes)</label>
            <div className="btn-row">
              <input id="zone2-target" className="input" type="number" min="1" max="10080" step="any" placeholder={String(weeklyTarget)} value={draft} onChange={(e) => setDraft(e.target.value)} disabled={saving} />
              <button className="btn btn-sm" disabled={saving || !draft.trim()}>{saving ? "Saving…" : "Save"}</button>
            </div>
            {days === 24 && <p className="faint small">The 24-day target is four times your 7-day target.</p>}
            {saveError && <p className="error-text" role="alert">{saveError}</p>}
          </form>
        </div>
      )}
    </section>
  );
}
