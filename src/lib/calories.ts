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
import { dayTarget, getPeriodGoal, loadGoalSettings } from "./goals";

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
  "Every calorie figure Tally holds, per day and over a day range. Use it for any calorie question (eaten, burned, net, budget left, deficit) rather than adding up meals and workouts yourself. The figures, which are the only calorie names to use (never call two different ones \"burned\"):",
  describeCalorieFigures(),
  "Each day row also has meals (food entries logged). A day with meals: 0 is usually untracked rather than a day without food, so it has no eaten, net, remaining or energy_balance. Today's row is marked in_progress; days after today are marked upcoming and carry only their target.",
  "totals: the range as the Diary's week/month card adds it up. target is base × days (a correction moves kcal between days, it doesn't change the total) and remaining is that target − net. burned_total sums the days the watch synced; energy_balance sums the days with both food and a watch total.",
  "averages: per finished day, so today (partial) is left out. eaten, burned_workouts, target, net and remaining are averaged over days with meals; burned_total over days the watch synced; energy_balance over days with both.",
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

export interface CalorieReading {
  start_day: string;
  end_day: string;
  days?: Record<string, unknown>[];
  totals: FigureValues;
  averages: FigureValues;
  coverage: { days: number; with_meals: number; with_watch_total: number };
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

/**
 * The calorie figures for a range of local days (inclusive). Each day is read
 * from what was stamped with it, as the Diary does.
 */
export async function readCalories(
  startDay: string,
  endDay: string,
  figures: readonly CalorieFigure[] = CALORIE_FIGURE_KEYS,
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

  const settings = await loadGoalSettings();
  const [entries, workouts, metrics, adjustments, period] = await Promise.all([
    listFoodEntriesForRange(startDay, endDay),
    listWorkoutsForRange(startDay, endDay),
    listHealthMetricsForRange(startDay, endDay),
    listDayGoalAdjustments(startDay, endDay),
    getPeriodGoal(startDay, endDay, settings),
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
  const figuresOf = (t: DayTally): Figures => {
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
      energy_balance:
        logged && t.burnedTotal != null ? t.eaten - t.burnedTotal : undefined,
    };
  };

  const notes: string[] = [];

  let days: Record<string, unknown>[] | undefined;
  if (tallies.length <= MAX_DAY_ROWS) {
    days = tallies.map((t) => ({
      day: t.day,
      ...(t.day === today ? { in_progress: true } : t.day > today ? { upcoming: true } : {}),
      meals: t.meals,
      ...(t.unestimated > 0 ? { meals_without_kcal: t.unestimated } : {}),
      ...pick(figuresOf(t), figures),
      ...(figures.includes("target") && base != null && t.correction !== 0
        ? { target_correction: Math.round(t.correction) }
        : {}),
    }));
  } else {
    notes.push(
      `Day rows are left out over ${tallies.length} days; ask for ${MAX_DAY_ROWS} days or fewer to get them.`,
    );
  }

  const withMeals = tallies.filter((t) => t.meals > 0);
  const withWatch = tallies.filter((t) => t.burnedTotal != null);
  const withBoth = withMeals.filter((t) => t.burnedTotal != null);

  const eaten = sum(tallies.map((t) => t.eaten));
  const net = eaten - sum(tallies.map((t) => t.burnedWorkouts));
  const totals: Figures = {
    eaten: withMeals.length > 0 ? eaten : undefined,
    burned_workouts: sum(tallies.map((t) => t.burnedWorkouts)),
    burned_total:
      withWatch.length > 0 ? sum(withWatch.map((t) => t.burnedTotal ?? 0)) : undefined,
    target: period?.target,
    net: withMeals.length > 0 ? net : undefined,
    remaining: period && withMeals.length > 0 ? period.target - net : undefined,
    energy_balance:
      withBoth.length > 0
        ? sum(withBoth.map((t) => t.eaten - (t.burnedTotal ?? 0)))
        : undefined,
  };

  // Finished days only: half of today would drag every average down.
  const finished = tallies.filter((t) => t.day < today);
  const loggedF = finished.filter((t) => t.meals > 0).map(figuresOf);
  const watchF = finished.filter((t) => t.burnedTotal != null).map(figuresOf);
  const bothF = finished
    .filter((t) => t.meals > 0 && t.burnedTotal != null)
    .map(figuresOf);
  const averages: Figures = {
    eaten: avgOf(loggedF, "eaten"),
    burned_workouts: avgOf(loggedF, "burned_workouts"),
    burned_total: avgOf(watchF, "burned_total"),
    target: avgOf(loggedF, "target"),
    net: avgOf(loggedF, "net"),
    remaining: avgOf(loggedF, "remaining"),
    energy_balance: avgOf(bothF, "energy_balance"),
  };

  if (base == null && (figures.includes("target") || figures.includes("remaining"))) {
    notes.push("No calorie target is set (Settings), so there is no target or remaining.");
  }
  if (
    withWatch.length === 0 &&
    (figures.includes("burned_total") || figures.includes("energy_balance"))
  ) {
    notes.push(
      "No watch total in this range, so there is no burned_total or energy_balance. It needs Health Connect sync (Settings → Watch sync).",
    );
  }

  return {
    start_day: startDay,
    end_day: endDay,
    ...(days ? { days } : {}),
    totals: pick(totals, figures),
    averages: pick(averages, figures),
    coverage: {
      days: tallies.length,
      with_meals: withMeals.length,
      with_watch_total: withWatch.length,
    },
    ...(notes.length > 0 ? { notes } : {}),
  };
}
