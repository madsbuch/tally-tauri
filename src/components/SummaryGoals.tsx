import { useEffect, useState } from "react";
import { exerciseTarget } from "../lib/exerciseGoals";
import { cardioMinutes, getCardioTarget, getDayGoal, getProteinTarget, loadGoalSettings } from "../lib/goals";
import type { Workout } from "../lib/types";

interface Targets {
  /** Net kcal per day; null = no calorie target set. */
  kcal: number | null;
  proteinG: number;
  /** Cardio minutes per 7 days. */
  cardioWeek: number;
}

const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 0 });

/**
 * A goal as a balance rather than a progress bar: over a range there's
 * nothing to fill up, just which side of the line you're on. The target is a
 * marker in the middle of the track; the side you shouldn't be on is shaded —
 * past it for a maximum (calories), short of it for a minimum (protein,
 * cardio) — and a dot shows where you are, in the warning colour when it's on
 * that side.
 */
function BalanceRow({
  name,
  value,
  target,
  unit,
  limit,
}: {
  name: string;
  value: number;
  target: number;
  unit: string;
  /** "max": staying under is the goal. "min": reaching it is. */
  limit: "max" | "min";
}) {
  // The track spans 0 to twice the target, so the target sits in the middle
  // and a value far off either way still lands on the track (pinned at the end).
  const span = target * 2;
  const pos = span > 0 ? Math.min(100, Math.max(0, (value / span) * 100)) : 0;
  const bad = limit === "max" ? value > target : value < target;
  const word = limit === "max" ? "at most" : "at least";
  return (
    <div className="goal-row">
      <div className="summary-section-heading">
        <span className="goal-name">{name}</span>
        <span className="goal-value">
          {fmt(value)} <span className="muted">/ {word} {fmt(target)} {unit}</span>
        </span>
      </div>
      <div
        className={`balance balance-${limit}`}
        role="img"
        aria-label={`${name}: ${fmt(value)} ${unit}, goal ${word} ${fmt(target)} ${unit}${bad ? " — on the wrong side" : ""}`}
      >
        <div className="balance-bad" />
        <div className="balance-target" />
        <div className={`balance-dot${bad ? " balance-dot-bad" : ""}`} style={{ left: `${pos}%` }} />
      </div>
    </div>
  );
}

/**
 * The goals, as a summary of the Summary range: calories and protein per day
 * (averaged over a multi-day range, like the Energy card), cardio minutes in
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
      const [settings, protein, cardio] = await Promise.all([
        loadGoalSettings(),
        getProteinTarget(),
        getCardioTarget(),
      ]);
      // A single day carries its own correction; over a range those only move
      // room between days, so the base is the per-day budget (lib/goals.ts).
      const kcal = days === 1 ? ((await getDayGoal(day, settings))?.target ?? null) : settings.base;
      return {
        kcal,
        proteinG: protein,
        cardioWeek: cardio,
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
            <BalanceRow
              name={`Calories${perDay}`}
              value={Math.max(0, netKcalPerDay)}
              target={targets.kcal}
              unit="kcal"
              limit="max"
            />
          )}
          <BalanceRow
            name={`Protein${perDay}`}
            value={proteinPerDay}
            target={targets.proteinG}
            unit="g"
            limit="min"
          />
          <BalanceRow
            name="Cardio"
            value={cardioMinutes(workouts)}
            target={exerciseTarget(targets.cardioWeek, days)}
            unit="min"
            limit="min"
          />
        </div>
      )}
    </section>
  );
}

