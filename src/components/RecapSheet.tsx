import { useEffect, useState, useSyncExternalStore } from "react";
import AssistantChart from "./AssistantChart";
import {
  buildRecap,
  markRecapSeen,
  recapDayLabel,
  recapRangeOf,
  recapTitle,
  shiftRecapRange,
} from "../lib/recap";
import type { Recap, RecapPeriod, RecapRange, RecapStats } from "../lib/recap";
import { todayStr } from "../lib/db";
import { shiftDay } from "../lib/daystamp";
import { getAssistantState, subscribeAssistant } from "../lib/assistantRunner";

function hm(min: number): string {
  return `${Math.floor(min / 60)}h ${String(Math.round(min % 60)).padStart(2, "0")}m`;
}

function compact(n: number): string {
  if (n < 10_000) return Math.round(n).toLocaleString();
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(
    n,
  );
}

/**
 * The change since the period before, in plain ink with an arrow. Deliberately
 * not green/red: more calories or fewer steps isn't good or bad on its own.
 */
function Delta({
  now,
  before,
  format,
  vs,
}: {
  now: number | null;
  before: number | null | undefined;
  format: (n: number) => string;
  vs: string;
}) {
  if (now == null || before == null) return null;
  const diff = now - before;
  const shown = format(Math.abs(diff));
  if (shown === format(0)) {
    return <div className="recap-delta">= {vs}</div>;
  }
  const up = diff > 0;
  return (
    <div className="recap-delta" aria-label={`${up ? "up" : "down"} ${shown} ${vs}`}>
      {up ? "▲" : "▼"} {shown}
    </div>
  );
}

interface Tile {
  key: string;
  value: string;
  label: string;
  now: number | null;
  before: number | null | undefined;
  format: (n: number) => string;
}

/** The tiles worth showing — one with no data (no watch, no fasts) is left out. */
function tilesOf(s: RecapStats, p: RecapStats | null): Tile[] {
  const round = (n: number) => Math.round(n).toLocaleString();
  const tiles: (Tile | null)[] = [
    {
      key: "days",
      value: `${s.daysLogged}/${s.days}`,
      label: "Days logged",
      now: s.daysLogged,
      before: p?.daysLogged,
      format: round,
    },
    s.avgKcal != null
      ? {
          key: "kcal",
          value: round(s.avgKcal),
          label: "Kcal / day",
          now: s.avgKcal,
          before: p?.avgKcal,
          format: round,
        }
      : null,
    s.avgProteinG != null
      ? {
          key: "protein",
          value: `${Math.round(s.avgProteinG)} g`,
          label: "Protein / day",
          now: s.avgProteinG,
          before: p?.avgProteinG,
          format: (n) => `${Math.round(n)} g`,
        }
      : null,
    {
      key: "workouts",
      value: String(s.workouts),
      label: "Workouts",
      now: s.workouts,
      before: p?.workouts,
      format: round,
    },
    s.fastHours >= 1 || (p?.fastHours ?? 0) >= 1
      ? {
          key: "fast",
          value: `${Math.round(s.fastHours)} h`,
          label: "Fasted",
          now: s.fastHours,
          before: p?.fastHours,
          format: (n) => `${Math.round(n)} h`,
        }
      : null,
    s.avgSleepMin != null
      ? {
          key: "sleep",
          value: hm(s.avgSleepMin),
          label: "Avg night",
          now: s.avgSleepMin,
          before: p?.avgSleepMin,
          format: (n) => (n >= 60 ? hm(n) : `${Math.round(n)}m`),
        }
      : null,
    s.avgSteps != null
      ? {
          key: "steps",
          value: compact(s.avgSteps),
          label: "Steps / day",
          now: s.avgSteps,
          before: p?.avgSteps,
          format: compact,
        }
      : null,
    s.weightDeltaKg != null
      ? {
          key: "weight",
          value: `${s.weightDeltaKg > 0 ? "+" : s.weightDeltaKg < 0 ? "−" : ""}${Math.abs(
            s.weightDeltaKg,
          ).toFixed(1)} kg`,
          label: "Weight",
          now: null,
          before: null,
          format: (n) => n.toFixed(1),
        }
      : null,
    s.avgRestingHr != null
      ? {
          key: "rhr",
          value: `${Math.round(s.avgRestingHr)}`,
          label: "Resting HR",
          now: s.avgRestingHr,
          before: p?.avgRestingHr,
          format: round,
        }
      : null,
  ];
  return tiles.filter((t): t is Tile => t !== null);
}

/**
 * Bottom sheet recapping one week or month: how many days were kept, the
 * period's numbers against the one before, a day-by-day calorie chart and
 * the highlights. Opens on whichever range it's given (the Diary offers the
 * week or month that just ended) and pages back and forth from there.
 */
export default function RecapSheet({
  initial,
  onClose,
  onAskCoach,
}: {
  initial: RecapRange;
  onClose: () => void;
  onAskCoach: (recap: Recap) => void;
}) {
  const [range, setRange] = useState<RecapRange>(initial);
  const [recap, setRecap] = useState<Recap | null>(null);
  const [error, setError] = useState<string | null>(null);
  // One turn at a time: while the coach is answering something else, a new
  // conversation can't start, so say so rather than drop the recap.
  const coachBusy =
    useSyncExternalStore(subscribeAssistant, getAssistantState).status === "running";
  const today = todayStr();

  useEffect(() => {
    let alive = true;
    setRecap(null);
    setError(null);
    buildRecap(range)
      .then((r) => {
        if (alive) setRecap(r);
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    if (range.end < today) void markRecapSeen(range);
    return () => {
      alive = false;
    };
  }, [range, today]);

  const switchPeriod = (period: RecapPeriod) => {
    if (period === range.period) return;
    // Land on the same moment in the other scale: the week's month, or the
    // month's last week that isn't in the future.
    const anchor = range.end < today ? range.end : today;
    setRange(recapRangeOf(period, period === "week" ? anchor : range.start));
  };

  const isCurrent = range.start <= today && today <= range.end;
  const vs = range.period === "week" ? "last week" : "last month";
  const s = recap?.stats;
  const tiles = recap && s ? tilesOf(s, recap.previous) : [];
  const hasKcal = recap?.dailyKcal.some((d) => d.kcal != null) ?? false;

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        <h2 className="sheet-title">📅 Recap</h2>

        <div className="seg" style={{ marginBottom: 10 }}>
          {(["week", "month"] as const).map((p) => (
            <button
              key={p}
              className={range.period === p ? "seg-item seg-item-active" : "seg-item"}
              onClick={() => switchPeriod(p)}
            >
              {p === "week" ? "Week" : "Month"}
            </button>
          ))}
        </div>

        <div className="day-nav" style={{ marginBottom: 4 }}>
          <button
            className="btn btn-sm"
            onClick={() => setRange((r) => shiftRecapRange(r, -1))}
            aria-label={`Previous ${range.period}`}
          >
            ‹
          </button>
          <div className="day-nav-title">{recapTitle(range)}</div>
          <button
            className="btn btn-sm"
            onClick={() => setRange((r) => shiftRecapRange(r, 1))}
            disabled={isCurrent}
            aria-label={`Next ${range.period}`}
          >
            ›
          </button>
        </div>

        {error && <div className="error-text">{error}</div>}

        {!recap && !error && (
          <div style={{ display: "flex", justifyContent: "center", padding: 24 }}>
            <span className="spinner" />
          </div>
        )}

        {recap && s && (
          <>
            <div className="faint small" style={{ margin: "0 2px 10px", textAlign: "center" }}>
              {recap.inProgress ? `So far — ${s.days} of ${daysIn(range)} days. ` : ""}
              {recap.previous
                ? `Arrows compare with ${recap.inProgress ? `the same days ${vs}` : vs}.`
                : `Nothing logged ${vs} to compare with.`}
            </div>

            <div className="stat-grid recap-grid">
              {tiles.map((t) => (
                <div key={t.key} className="stat">
                  <div className="stat-value">{t.value}</div>
                  <div className="stat-label">{t.label}</div>
                  {recap.previous && (
                    <Delta now={t.now} before={t.before} format={t.format} vs={vs} />
                  )}
                </div>
              ))}
            </div>

            {hasKcal && (
              <div className="recap-chart">
                <AssistantChart
                  chart={{
                    type: "bar",
                    title: "Calories eaten",
                    unit: "kcal",
                    x_labels: recap.dailyKcal.map((d) => recapDayLabel(range.period, d.day)),
                    series: [
                      {
                        name: "Calories eaten",
                        values: recap.dailyKcal.map((d) =>
                          d.kcal != null ? Math.round(d.kcal) : null,
                        ),
                      },
                    ],
                  }}
                />
              </div>
            )}

            <div className="section-title">Highlights</div>
            <div className="list">
              <Highlight
                emoji="🔥"
                title={
                  recap.longestRun > 0
                    ? `${recap.longestRun} ${recap.longestRun === 1 ? "day" : "days"} in a row`
                    : "No logged days yet"
                }
                sub="Longest run of logged days"
              />
              {recap.longestFastH >= 1 && (
                <Highlight
                  emoji="⏳"
                  title={`${Math.round(recap.longestFastH)} hours`}
                  sub="Longest fast"
                />
              )}
              {recap.topMeals.length > 0 && (
                <Highlight
                  emoji="🍽️"
                  title={recap.topMeals.map((m) => `${m.title} ×${m.count}`).join(", ")}
                  sub="Most logged"
                />
              )}
              {recap.states.length > 0 && (
                <Highlight
                  emoji={recap.states[0]?.icon ?? "💭"}
                  title={recap.states.map((x) => `${x.label} ×${x.count}`).join(", ")}
                  sub="How you felt"
                />
              )}
              {recap.badges.length > 0 && (
                <Highlight
                  emoji="🏆"
                  title={recap.badges.map((b) => `${b.emoji} ${b.title}`).join(", ")}
                  sub={recap.badges.length === 1 ? "Badge earned" : `${recap.badges.length} badges earned`}
                />
              )}
            </div>

            {s.daysLogged > 0 && (
              <button
                className="btn btn-block"
                style={{ marginTop: 14 }}
                onClick={() => onAskCoach(recap)}
                disabled={coachBusy}
              >
                {coachBusy
                  ? "The coach is answering something else…"
                  : "💬 Talk it over with the coach"}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function daysIn(range: RecapRange): number {
  let n = 0;
  for (let d = range.start; d <= range.end; d = shiftDay(d, 1)) n++;
  return n;
}

function Highlight({ emoji, title, sub }: { emoji: string; title: string; sub: string }) {
  return (
    <div className="list-row">
      <span className="ach-emoji" aria-hidden>
        {emoji}
      </span>
      <div className="row-main">
        <div className="row-title">{title}</div>
        <div className="row-sub">{sub}</div>
      </div>
    </div>
  );
}
