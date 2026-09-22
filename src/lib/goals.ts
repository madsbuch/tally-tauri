/**
 * Daily calorie goal with corrections.
 *
 * The Settings target is a *base* budget. What a day is actually measured
 * against is
 *
 *     target(day) = base + manual(day) + rollover(day)
 *
 * where `manual` is a correction the user typed on the Diary page (stored in
 * `day_goal_adjustments`) and `rollover` is derived automatically from how
 * the previous days went: eat 200 kcal over yesterday and today's budget is
 * 200 kcal smaller, all by itself.
 *
 * The rollover is a *rolling balance* over a window, not just yesterday. That
 * matters: a yesterday-only carry would swing back and forth forever (pay the
 * debt today → today looks like a surplus → tomorrow's budget goes up again).
 * Summing the window lets a repaid debt cancel itself out and settle at zero.
 *
 * Only days with something to judge take part: a day with food logged, or one
 * covered by a fast (deliberately not eating is a real deficit — this app
 * treats fasting and eating the calories later in the week as a valid
 * pattern). Days the user simply forgot to log contribute nothing instead of
 * handing out a full day's phantom credit.
 *
 * `cap` bounds how much a single day's budget may move, so one blow-out
 * weekend can't hand you a starvation Monday.
 *
 * Multi-day periods (the Diary's week/month totals) deliberately ignore the
 * rollover: it only moves budget *between* days inside the period and nets
 * out, so a week's target stays base × days, plus any manual corrections.
 */
import {
  getSetting,
  listAllFasts,
  listDayGoalAdjustments,
  listFoodEntriesForRange,
  listWorkoutsForRange,
  todayStr,
} from "./db";
import { SETTING_KEYS } from "./types";
import type { DayGoalAdjustment, Fast } from "./types";

export type RolloverMode = "off" | "week" | "month";

/** How many days back the rolling balance looks, per mode. */
export const ROLLOVER_WINDOW_DAYS: Record<RolloverMode, number> = {
  off: 0,
  week: 7,
  month: 30,
};

export const DEFAULT_ROLLOVER_MODE: RolloverMode = "week";
export const DEFAULT_ROLLOVER_CAP = 500;
export const MIN_ROLLOVER_CAP = 50;
export const MAX_ROLLOVER_CAP = 2000;

/** Largest manual correction accepted, either way. */
export const MAX_MANUAL_ADJUSTMENT = 2000;

export const ROLLOVER_LABELS: Record<RolloverMode, string> = {
  off: "Off",
  week: "7 days",
  month: "30 days",
};

export interface GoalSettings {
  /** Daily base target in kcal; null = no target configured. */
  base: number | null;
  mode: RolloverMode;
  /** Max kcal the rollover may add to or take off one day. */
  cap: number;
}

export interface DayGoal {
  day: string;
  base: number;
  /** The user's own correction for this day (signed kcal). */
  manual: number;
  /** Automatic carry-over from the window before this day (signed kcal). */
  rollover: number;
  /** The balance before the cap was applied — the UI says when it clipped. */
  rawRollover: number;
  /** How many days actually fed the balance. */
  balanceDays: number;
  /** base + manual + rollover, floored at a token minimum. */
  target: number;
  mode: RolloverMode;
  cap: number;
}

export interface PeriodGoal {
  base: number;
  days: number;
  /** Sum of the manual corrections inside the period. */
  manual: number;
  /** base × days + manual — the rollover nets out inside a period. */
  target: number;
}

/**
 * A day's budget never drops below this, however deep the debt: the app
 * should nudge, not prescribe starvation.
 */
export const MIN_DAY_TARGET = 200;

function shiftDay(day: string, delta: number): string {
  const [y = 0, m = 1, d = 1] = day.split("-").map(Number);
  return todayStr(new Date(y, m - 1, d + delta));
}

function localDayOf(iso: string): string {
  return todayStr(new Date(iso));
}

function parseMode(raw: string | null): RolloverMode {
  return raw === "off" || raw === "week" || raw === "month" ? raw : DEFAULT_ROLLOVER_MODE;
}

function parseCap(raw: string | null): number {
  const n = raw != null ? parseFloat(raw) : NaN;
  if (!isFinite(n)) return DEFAULT_ROLLOVER_CAP;
  return Math.min(MAX_ROLLOVER_CAP, Math.max(MIN_ROLLOVER_CAP, Math.round(n)));
}

export async function loadGoalSettings(): Promise<GoalSettings> {
  const [rawBase, rawMode, rawCap] = await Promise.all([
    getSetting(SETTING_KEYS.calorieTarget).catch(() => null),
    getSetting(SETTING_KEYS.calorieRollover).catch(() => null),
    getSetting(SETTING_KEYS.calorieRolloverCap).catch(() => null),
  ]);
  const base = rawBase != null ? parseFloat(rawBase) : NaN;
  return {
    base: isFinite(base) && base > 0 ? base : null,
    mode: parseMode(rawMode),
    cap: parseCap(rawCap),
  };
}

/** The local days a fast covers, both ends inclusive. */
function fastDays(f: Fast, today: string): string[] {
  const out: string[] = [];
  const end = f.ended_at ? localDayOf(f.ended_at) : today;
  for (let d = localDayOf(f.started_at); d <= end; d = shiftDay(d, 1)) out.push(d);
  return out;
}

function manualMap(rows: DayGoalAdjustment[]): Map<string, number> {
  return new Map(rows.map((r) => [r.day, r.delta_kcal]));
}

/** One past day, as the rolling balance sees it. */
export interface DayFacts {
  /** Net kcal that day: eaten − burned. */
  net: number;
  /** The user's own correction to that day's target. */
  manual: number;
  /**
   * Whether the day can be judged at all: food was logged, or a fast covered
   * it. An untracked day contributes nothing — crediting a full day's budget
   * for a day that simply went unlogged would inflate every later target.
   */
  tracked: boolean;
}

/**
 * The rolling balance: how far the window's tracked days came in under (+) or
 * over (−) their own budgets, summed. Exported for testing.
 */
export function rolloverBalance(
  base: number,
  window: DayFacts[],
): { balance: number; trackedDays: number } {
  let balance = 0;
  let trackedDays = 0;
  for (const d of window) {
    if (!d.tracked) continue;
    trackedDays++;
    balance += base + d.manual - d.net;
  }
  return { balance: Math.round(balance), trackedDays };
}

/**
 * The full breakdown of one day's calorie budget, or null when no base target
 * is configured (the Diary hides the card then).
 */
export async function getDayGoal(
  day: string,
  settings?: GoalSettings,
): Promise<DayGoal | null> {
  const s = settings ?? (await loadGoalSettings());
  if (s.base == null) return null;

  const window = ROLLOVER_WINDOW_DAYS[s.mode];
  const from = shiftDay(day, -window);
  const to = shiftDay(day, -1);

  // The day's own correction always applies; the window is only read when the
  // rollover is switched on.
  const adjustments = await listDayGoalAdjustments(window > 0 ? from : day, day);
  const manuals = manualMap(adjustments);
  const manual = manuals.get(day) ?? 0;

  let rawRollover = 0;
  let balanceDays = 0;
  if (window > 0) {
    const [entries, workouts, fasts] = await Promise.all([
      listFoodEntriesForRange(from, to),
      listWorkoutsForRange(from, to),
      listAllFasts(),
    ]);

    const today = todayStr();
    const net = new Map<string, number>();
    const hasFood = new Set<string>();
    for (const e of entries) {
      const d = localDayOf(e.eaten_at);
      hasFood.add(d);
      net.set(d, (net.get(d) ?? 0) + (e.nutrients.calories ?? 0));
    }
    for (const w of workouts) {
      const d = localDayOf(w.performed_at);
      net.set(d, (net.get(d) ?? 0) - w.calories_burned);
    }
    const fasted = new Set<string>();
    for (const f of fasts) {
      for (const d of fastDays(f, today)) {
        if (d >= from && d <= to) fasted.add(d);
      }
    }

    const facts: DayFacts[] = [];
    for (let d = from; d <= to; d = shiftDay(d, 1)) {
      facts.push({
        net: net.get(d) ?? 0,
        manual: manuals.get(d) ?? 0,
        tracked: hasFood.has(d) || fasted.has(d),
      });
    }
    const rolled = rolloverBalance(s.base, facts);
    rawRollover = rolled.balance;
    balanceDays = rolled.trackedDays;
  }

  const rollover = Math.max(-s.cap, Math.min(s.cap, rawRollover));
  return {
    day,
    base: s.base,
    manual,
    rollover,
    rawRollover,
    balanceDays,
    target: Math.max(MIN_DAY_TARGET, s.base + manual + rollover),
    mode: s.mode,
    cap: s.cap,
  };
}

/**
 * The budget for a multi-day period: base × days plus the manual corrections
 * inside it. The rollover is left out on purpose — it shifts budget from one
 * day in the period to another and would otherwise be counted twice.
 */
export async function getPeriodGoal(
  startDay: string,
  endDay: string,
  settings?: GoalSettings,
): Promise<PeriodGoal | null> {
  const s = settings ?? (await loadGoalSettings());
  if (s.base == null) return null;
  const adjustments = await listDayGoalAdjustments(startDay, endDay);
  const manual = adjustments.reduce((acc, a) => acc + a.delta_kcal, 0);
  let days = 0;
  for (let d = startDay; d <= endDay; d = shiftDay(d, 1)) days++;
  return { base: s.base, days, manual, target: s.base * days + manual };
}
