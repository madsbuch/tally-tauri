/**
 * Calorie figures: every calorie number Tally can tell the coach, each under
 * one name.
 *
 * "Burned" alone could mean what a workout burned or what the whole day
 * burned, and the two differ by a resting metabolism — well over a thousand
 * kcal. So the coach never reads a bare "calories": `query_calories` speaks
 * only the names below, and its description is written from this list.
 *
 *   in       eaten            the food diary, added up
 *   out      burned_workouts  what logged workouts burned (by hand or synced)
 *            burned_total     the watch's whole-day burn, resting included
 *   budget   target           the day's budget for net kcal
 *   balance  net              eaten − burned_workouts
 *            remaining        target − net
 *            energy_balance   eaten − burned_total
 *
 * net is the Diary's number: the calorie bar is net against the target, and
 * the target already allows for an ordinary day's resting burn, so taking
 * burned_total off as well would count the resting burn twice.
 * energy_balance answers the other question — all in, did they eat more or
 * less than they burned — and exists only on days the watch syncs a total.
 */
import {
  listDayGoalAdjustments,
  listFoodEntriesForRange,
  listHealthMetricsForRange,
  listWorkoutsForRange,
  todayStr,
} from "./db";
import { dayOf, shiftDay } from "./daystamp";
import { dayTarget, loadGoalSettings, periodTarget } from "./goals";

export type CalorieFamily = "in" | "out" | "budget" | "balance";

export const CALORIE_FIGURES = [
  {
    key: "eaten",
    family: "in",
    meaning:
      "kcal from the food diary, each meal's estimate added up. Supplements don't count. A meal with no estimate counts as 0; rows flag those as meals_without_kcal.",
  },
  {
    key: "burned_workouts",
    family: "out",
    meaning:
      'kcal burned by logged workouts, entered by hand or synced from the watch (the session\'s active calories). The "burned" the Diary subtracts.',
  },
  {
    key: "burned_total",
    family: "out",
    meaning:
      "the watch's whole-day burn from Health Connect: resting metabolism + everyday movement + workouts. It already contains burned_workouts, so never add the two. Absent on days the watch didn't sync. Today's keeps counting until midnight.",
  },
  {
    key: "target",
    family: "budget",
    meaning:
      "the day's budget for net kcal: the base from Settings plus any correction made to that day (shown as target_correction), never below 200. Absent when no target is set.",
  },
  {
    key: "net",
    family: "balance",
    meaning:
      "eaten − burned_workouts. What the Diary's calorie bar shows and what target is measured against. The target already allows for an ordinary day's resting burn.",
  },
  {
    key: "remaining",
    family: "balance",
    meaning: "target − net: kcal left in the budget. Negative means over.",
  },
  {
    key: "energy_balance",
    family: "balance",
    meaning:
      "eaten − burned_total: what was eaten against everything burned. Negative is a deficit, positive a surplus. Only on days with both food and a watch total. Today's reads high until the day's burn is in.",
  },
] as const satisfies readonly { key: string; family: CalorieFamily; meaning: string }[];

export type CalorieFigure = (typeof CALORIE_FIGURES)[number]["key"];

export const CALORIE_FIGURE_KEYS: readonly CalorieFigure[] = CALORIE_FIGURES.map(
  (f) => f.key,
);

const FAMILY_LABELS: Record<CalorieFamily, string> = {
  in: "Energy in",
  out: "Energy out",
  budget: "Budget",
  balance: "Balances",
};

/** The taxonomy, grouped by family, as the model reads it. */
export function describeCalorieFigures(): string {
  return (Object.keys(FAMILY_LABELS) as CalorieFamily[])
    .map(
      (family) =>
        `${FAMILY_LABELS[family]}: ` +
        CALORIE_FIGURES.filter((f) => f.family === family)
          .map((f) => `${f.key} = ${f.meaning}`)
          .join(" "),
    )
    .join("\n");
}

export const CALORIES_TOOL_DESCRIPTION = [
  "Every calorie figure Tally holds, summed over a day range and broken down by day, week or month. Use it for any calorie question (eaten, burned, net, budget left, deficit) rather than adding up meals and workouts yourself. The figures, which are the only calorie names to use (never call two different ones \"burned\"):",
  describeCalorieFigures(),
  "Each day row also has meals (food entries logged). A day with meals: 0 is usually untracked rather than a day without food, so it has no eaten, net, remaining or energy_balance. Today's row is marked in_progress; days after today are marked upcoming and carry only their target.",
  "totals: the range as the Diary's week/month card adds it up. target is base × days (a correction moves kcal between days, it doesn't change the total) and remaining is that target − net. burned_total sums the days the watch synced; energy_balance sums the days with both food and a watch total.",
  "averages: per finished day, so today (partial) is left out. eaten, burned_workouts, target, net and remaining are averaged over days with meals; burned_total over days the watch synced; energy_balance over days with both.",
  "group_by week (Monday to Sunday, as on the Diary) or month (calendar months) gives periods instead of day rows: each period has its own totals, averages and coverage, worked out the same way. The first and last period are cut to the range and marked clipped, and the one holding today is in_progress, so compare those by their averages, not their totals. For a rolling stretch (\"the last 7 days\", \"the last 30 days\") pass that range and read its totals and averages.",
].join("\n");

export function isCalorieFigure(x: unknown): x is CalorieFigure {
  return typeof x === "string" && (CALORIE_FIGURE_KEYS as readonly string[]).includes(x);
}

/** The `figures` tool argument: absent or empty means all of them. */
export function parseCalorieFigures(raw: unknown): CalorieFigure[] {
  if (raw == null) return [...CALORIE_FIGURE_KEYS];
  if (!Array.isArray(raw)) throw new Error("figures must be an array of figure names");
  const unknown = raw.filter((f) => !isCalorieFigure(f));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown figure ${unknown.map((f) => JSON.stringify(f)).join(", ")}; use one of: ${CALORIE_FIGURE_KEYS.join(", ")}`,
    );
  }
  return raw.length > 0 ? raw.filter(isCalorieFigure) : [...CALORIE_FIGURE_KEYS];
}

/** A day's or a range's figures; a figure that doesn't apply is undefined. */
type Figures = Partial<Record<CalorieFigure, number | undefined>>;
/** The same, rounded and with the missing ones left out, as the model reads it. */
type FigureValues = Partial<Record<CalorieFigure, number>>;

/** A year of totals is plenty; beyond that, run_sql. */
const MAX_RANGE_DAYS = 366;
/** Day rows past about a quarter cost more tokens than they're worth. */
const MAX_DAY_ROWS = 92;

/** How a range is broken up: a row per day, or per week or month. */
export type CalorieGrouping = "day" | "week" | "month";

export const CALORIE_GROUPINGS: readonly CalorieGrouping[] = ["day", "week", "month"];

/** The `group_by` tool argument: absent means a row per day. */
export function parseCalorieGrouping(raw: unknown): CalorieGrouping {
  if (raw == null) return "day";
  if (raw === "day" || raw === "week" || raw === "month") return raw;
  throw new Error(`group_by must be one of: ${CALORIE_GROUPINGS.join(", ")}`);
}

interface Coverage {
  days: number;
  with_meals: number;
  with_watch_total: number;
}

/** One week or month of the range, summed up as the range itself is. */
export interface CaloriePeriod {
  start_day: string;
  end_day: string;
  in_progress?: true;
  upcoming?: true;
  /** Cut short by the range, so fewer days than a whole week or month. */
  clipped?: true;
  totals: FigureValues;
  averages?: FigureValues;
  coverage: Coverage;
}

export interface CalorieReading {
  start_day: string;
  end_day: string;
  group_by: CalorieGrouping;
  days?: Record<string, unknown>[];
  periods?: CaloriePeriod[];
  totals: FigureValues;
  averages: FigureValues;
  coverage: Coverage;
  notes?: string[];
}

interface DayTally {
  day: string;
  meals: number;
  unestimated: number;
  eaten: number;
  burnedWorkouts: number;
  burnedTotal: number | null;
  correction: number;
}

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

function pick(all: Figures, figures: readonly CalorieFigure[]): FigureValues {
  const out: FigureValues = {};
  for (const k of figures) {
    const v = all[k];
    if (v != null && isFinite(v)) out[k] = Math.round(v);
  }
  return out;
}

/** Average of `key` over the given days, skipping days that don't have it. */
function avgOf(days: Figures[], key: CalorieFigure): number | undefined {
  const vs = days.map((d) => d[key]).filter((v): v is number => v != null);
  return vs.length > 0 ? sum(vs) / vs.length : undefined;
}

/** The Monday of the Monday-to-Sunday week `day` falls in, as on the Diary. */
function mondayOf(day: string): string {
  const [y = 0, m = 1, d = 1] = day.split("-").map(Number);
  return shiftDay(day, -((new Date(y, m - 1, d).getDay() + 6) % 7));
}

/** One day's figures; `base` is the Settings target, null when none is set. */
function dayFigures(t: DayTally, base: number | null, today: string): Figures {
  const logged = t.meals > 0;
  const target = base == null ? undefined : dayTarget(base, t.correction);
  const net = logged ? t.eaten - t.burnedWorkouts : undefined;
  return {
    eaten: logged ? t.eaten : undefined,
    // A day still ahead has burned nothing yet; only its budget is known.
    burned_workouts: t.day > today ? undefined : t.burnedWorkouts,
    burned_total: t.burnedTotal ?? undefined,
    target,
    net,
    remaining: target != null && net != null ? target - net : undefined,
    energy_balance: logged && t.burnedTotal != null ? t.eaten - t.burnedTotal : undefined,
  };
}

/**
 * Totals and averages over a run of days — the whole range, or one week or
 * month of it. Totals add up the way the Diary's week/month card does;
 * averages are over finished days only, since half of today would drag them
 * all down.
 */
function summarize(
  tallies: DayTally[],
  base: number | null,
  today: string,
): { totals: Figures; averages: Figures; coverage: Coverage } {
  const withMeals = tallies.filter((t) => t.meals > 0);
  const withWatch = tallies.filter((t) => t.burnedTotal != null);
  const withBoth = withMeals.filter((t) => t.burnedTotal != null);

  const eaten = sum(tallies.map((t) => t.eaten));
  const net = eaten - sum(tallies.map((t) => t.burnedWorkouts));
  const target = base == null ? undefined : periodTarget(base, tallies.length);
  const totals: Figures = {
    eaten: withMeals.length > 0 ? eaten : undefined,
    burned_workouts: sum(tallies.map((t) => t.burnedWorkouts)),
    burned_total:
      withWatch.length > 0 ? sum(withWatch.map((t) => t.burnedTotal ?? 0)) : undefined,
    target,
    net: withMeals.length > 0 ? net : undefined,
    remaining: target != null && withMeals.length > 0 ? target - net : undefined,
    energy_balance:
      withBoth.length > 0
        ? sum(withBoth.map((t) => t.eaten - (t.burnedTotal ?? 0)))
        : undefined,
  };

  const finished = tallies.filter((t) => t.day < today);
  const of = (ts: DayTally[]) => ts.map((t) => dayFigures(t, base, today));
  const logged = of(finished.filter((t) => t.meals > 0));
  const watch = of(finished.filter((t) => t.burnedTotal != null));
  const both = of(finished.filter((t) => t.meals > 0 && t.burnedTotal != null));
  const averages: Figures = {
    eaten: avgOf(logged, "eaten"),
    burned_workouts: avgOf(logged, "burned_workouts"),
    burned_total: avgOf(watch, "burned_total"),
    target: avgOf(logged, "target"),
    net: avgOf(logged, "net"),
    remaining: avgOf(logged, "remaining"),
    energy_balance: avgOf(both, "energy_balance"),
  };

  return {
    totals,
    averages,
    coverage: {
      days: tallies.length,
      with_meals: withMeals.length,
      with_watch_total: withWatch.length,
    },
  };
}

/**
 * The calorie figures for a range of local days (inclusive), with a row per
 * day, week or month. Each day is read from what was stamped with it, as the
 * Diary does.
 */
export async function readCalories(
  startDay: string,
  endDay: string,
  figures: readonly CalorieFigure[] = CALORIE_FIGURE_KEYS,
  groupBy: CalorieGrouping = "day",
): Promise<CalorieReading> {
  const allDays: string[] = [];
  for (let d = startDay; d <= endDay; d = shiftDay(d, 1)) {
    allDays.push(d);
    if (allDays.length > MAX_RANGE_DAYS) {
      throw new Error(
        `At most ${MAX_RANGE_DAYS} days at a time; narrow the range or use run_sql.`,
      );
    }
  }

  const [settings, entries, workouts, metrics, adjustments] = await Promise.all([
    loadGoalSettings(),
    listFoodEntriesForRange(startDay, endDay),
    listWorkoutsForRange(startDay, endDay),
    listHealthMetricsForRange(startDay, endDay),
    listDayGoalAdjustments(startDay, endDay),
  ]);

  const byDay = new Map<string, DayTally>(
    allDays.map((day) => [
      day,
      {
        day,
        meals: 0,
        unestimated: 0,
        eaten: 0,
        burnedWorkouts: 0,
        burnedTotal: null,
        correction: 0,
      },
    ]),
  );
  for (const e of entries) {
    const t = byDay.get(e.day ?? dayOf(e.eaten_at, e.tz_offset_min));
    if (!t) continue;
    t.meals++;
    const kcal = e.nutrients.calories;
    if (typeof kcal === "number" && isFinite(kcal)) t.eaten += kcal;
    else t.unestimated++;
  }
  for (const w of workouts) {
    const t = byDay.get(w.day ?? dayOf(w.performed_at, w.tz_offset_min));
    if (t) t.burnedWorkouts += w.calories_burned;
  }
  for (const m of metrics) {
    const t = byDay.get(m.day);
    if (t && m.calories_total != null) t.burnedTotal = m.calories_total;
  }
  for (const a of adjustments) {
    const t = byDay.get(a.day);
    if (t) t.correction = a.delta_kcal;
  }

  const tallies = [...byDay.values()];
  const base = settings.base;
  const today = todayStr();
  const notes: string[] = [];

  let days: Record<string, unknown>[] | undefined;
  let periods: CaloriePeriod[] | undefined;
  if (groupBy === "day") {
    if (tallies.length <= MAX_DAY_ROWS) {
      days = tallies.map((t) => ({
        day: t.day,
        ...(t.day === today ? { in_progress: true } : t.day > today ? { upcoming: true } : {}),
        meals: t.meals,
        ...(t.unestimated > 0 ? { meals_without_kcal: t.unestimated } : {}),
        ...pick(dayFigures(t, base, today), figures),
        ...(figures.includes("target") && base != null && t.correction !== 0
          ? { target_correction: Math.round(t.correction) }
          : {}),
      }));
    } else {
      notes.push(
        `Day rows are left out over ${tallies.length} days; ask for ${MAX_DAY_ROWS} days or fewer, or group_by week or month.`,
      );
    }
  } else {
    // Weeks are keyed by their Monday, months by "YYYY-MM".
    const keyOf = groupBy === "week" ? mondayOf : (day: string) => day.slice(0, 7);
    const groups = new Map<string, DayTally[]>();
    for (const t of tallies) {
      const k = keyOf(t.day);
      groups.set(k, [...(groups.get(k) ?? []), t]);
    }
    periods = [...groups].map(([key, run]) => {
      const first = run[0]?.day ?? startDay;
      const last = run[run.length - 1]?.day ?? endDay;
      const clipped =
        groupBy === "week"
          ? first !== key || last !== shiftDay(key, 6)
          : !first.endsWith("-01") || keyOf(shiftDay(last, 1)) === key;
      const s = summarize(run, base, today);
      const averages = pick(s.averages, figures);
      return {
        start_day: first,
        end_day: last,
        ...(first <= today && today <= last
          ? { in_progress: true as const }
          : first > today
            ? { upcoming: true as const }
            : {}),
        ...(clipped ? { clipped: true as const } : {}),
        totals: pick(s.totals, figures),
        ...(Object.keys(averages).length > 0 ? { averages } : {}),
        coverage: s.coverage,
      };
    });
  }

  const whole = summarize(tallies, base, today);
  if (base == null && (figures.includes("target") || figures.includes("remaining"))) {
    notes.push("No calorie target is set (Settings), so there is no target or remaining.");
  }
  if (
    whole.coverage.with_watch_total === 0 &&
    (figures.includes("burned_total") || figures.includes("energy_balance"))
  ) {
    notes.push(
      "No watch total in this range, so there is no burned_total or energy_balance. It needs Health Connect sync (Settings → Watch sync).",
    );
  }

  return {
    start_day: startDay,
    end_day: endDay,
    group_by: groupBy,
    ...(days ? { days } : {}),
    ...(periods ? { periods } : {}),
    totals: pick(whole.totals, figures),
    averages: pick(whole.averages, figures),
    coverage: whole.coverage,
    ...(notes.length > 0 ? { notes } : {}),
  };
}
