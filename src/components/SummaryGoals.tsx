import { useEffect, useState } from "react";
import { getSetting } from "../lib/db";
import { DEFAULT_ZONE2_TARGET, exerciseProgress, exerciseTarget } from "../lib/exerciseGoals";
import { getDayGoal, loadGoalSettings } from "../lib/goals";
import { DEFAULT_PROTEIN_TARGET_G, SETTING_KEYS } from "../lib/types";
import type { Workout } from "../lib/types";

interface Targets {
  /** Net kcal per day; null = no calorie target set. */
  kcal: number | null;
  proteinG: number;
  /** Zone 2 minutes per 7 days. */
  zone2Week: number;
}

function positive(raw: string | null, fallback: number, max = Infinity): number {
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 && n <= max ? n : fallback;
}

const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 0 });

function GoalRow({
  name,
  value,
  target,
  unit,
  status,
  over,
}: {
  name: string;
  value: number;
  target: number;
  unit: string;
  status: string;
  /** Past the target and that's bad (a calorie budget), not good. */
  over?: boolean;
}) {
  const pct = target > 0 ? Math.min(100, (value / target) * 100) : 0;
  return (
    <div className="goal-row">
      <div className="summary-section-heading">
        <strong>{name}</strong>
        <span>
          {fmt(value)} / {fmt(target)} {unit}
        </span>
      </div>
      <div
        className={`exercise-meter${over ? " goal-meter-over" : ""}`}
        role="progressbar"
        aria-label={`${name} goal`}
        aria-valuenow={Math.min(target, value)}
        aria-valuemin={0}
        aria-valuemax={target}
        aria-valuetext={`${fmt(value)} of ${fmt(target)} ${unit}`}
      >
        <div style={{ width: `${pct}%` }} />
      </div>
      <div className={`small ${over ? "goal-over" : "muted"}`}>{status}</div>
    </div>
  );
}

/**
 * The goals, as a summary of the Summary range: calories and protein per day
 * (averaged over a multi-day range, like the Energy card), Zone 2 minutes in
 * total. Targets are stored settings with no editor here — they change
 * rarely, and on request.
 */
export default function SummaryGoals({
  workouts,
  netKcalPerDay,
  proteinPerDay,
  day,
  days,
  label,
}: {
  workouts: Workout[];
  netKcalPerDay: number;
  proteinPerDay: number;
  /** Last day of the range. */
  day: string;
  days: number;
  label: string;
}) {
  const [targets, setTargets] = useState<Targets | null>(null);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [settings, protein, zone2] = await Promise.all([
        loadGoalSettings(),
        getSetting(SETTING_KEYS.proteinTarget),
        getSetting(SETTING_KEYS.zone2WeeklyTarget),
      ]);
      // A single day carries its own correction; over a range those only move
      // room between days, so the base is the per-day budget (lib/goals.ts).
      const kcal = days === 1 ? ((await getDayGoal(day, settings))?.target ?? null) : settings.base;
      return {
        kcal,
        proteinG: positive(protein, DEFAULT_PROTEIN_TARGET_G),
        zone2Week: positive(zone2, DEFAULT_ZONE2_TARGET, 10080),
      };
    })()
      .then((t) => {
        if (cancelled) return;
        setTargets(t);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [day, days, reload]);

  const perDay = days > 1 ? " · avg/day" : "";

  return (
    <section className="card exercise-goals" aria-label="Goals">
      <div className="summary-section-heading">
        <h2 className="card-title" style={{ margin: 0 }}>Goals</h2>
        <span className="faint small">{label}</span>
      </div>
      {error ? (
        <div role="alert">
          <p className="error-text">{error}</p>
          <button className="btn btn-sm" onClick={() => setReload((n) => n + 1)}>Retry</button>
        </div>
      ) : targets == null ? (
        <p className="muted small">Loading goals…</p>
      ) : (
        <div className="exercise-goal-body">
          {targets.kcal != null && (
            <GoalRow
              name={`Calories${perDay}`}
              value={Math.max(0, netKcalPerDay)}
              target={targets.kcal}
              unit="kcal"
              over={netKcalPerDay > targets.kcal}
              status={
                netKcalPerDay > targets.kcal
                  ? `${fmt(netKcalPerDay - targets.kcal)} kcal over`
                  : `${fmt(targets.kcal - netKcalPerDay)} kcal left`
              }
            />
          )}
          <GoalRow
            name={`Protein${perDay}`}
            value={proteinPerDay}
            target={targets.proteinG}
            unit="g"
            status={
              proteinPerDay >= targets.proteinG
                ? "Goal reached"
                : `${fmt(targets.proteinG - proteinPerDay)} g to go`
            }
          />
          <ZoneTwoRow workouts={workouts} weeklyTarget={targets.zone2Week} days={days} />
        </div>
      )}
    </section>
  );
}

function ZoneTwoRow({
  workouts,
  weeklyTarget,
  days,
}: {
  workouts: Workout[];
  weeklyTarget: number;
  days: number;
}) {
  const target = exerciseTarget(weeklyTarget, days);
  const progress = exerciseProgress(workouts, target);
  return (
    <GoalRow
      name="Zone 2"
      value={progress.minutes}
      target={target}
      unit="min"
      status={progress.remaining > 0 ? `${fmt(progress.remaining)} min remaining` : "Goal reached"}
    />
  );
}
