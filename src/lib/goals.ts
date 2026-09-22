/**
 * Daily calorie goal with per-day corrections.
 *
 * The Settings target is a *base* budget that applies to every day. A single
 * day can be corrected on the Diary page — "I overate yesterday, take 200 off
 * today" — and that correction is stored in `day_goal_adjustments`:
 *
 *     target(day) = base + manual(day)
 *
 * Nothing is derived or carried between days: a correction applies to exactly
 * the day it was made on and nowhere else.
 *
 * Multi-day periods (the Diary's week/month totals) are base × days plus the
 * corrections that fall inside the period.
 */
import { getSetting, listDayGoalAdjustments, todayStr } from "./db";
import { SETTING_KEYS } from "./types";

/** Largest per-day correction accepted, either way. */
export const MAX_MANUAL_ADJUSTMENT = 2000;

/**
 * A day's budget never drops below this, however large a correction: the app
 * should nudge, not prescribe starvation.
 */
export const MIN_DAY_TARGET = 200;

export interface GoalSettings {
  /** Daily base target in kcal; null = no target configured. */
  base: number | null;
}

export interface DayGoal {
  day: string;
  base: number;
  /** The correction made for this day (signed kcal); 0 = none. */
  manual: number;
  /** base + manual, floored at MIN_DAY_TARGET. */
  target: number;
}

export interface PeriodGoal {
  base: number;
  days: number;
  /** Sum of the corrections inside the period. */
  manual: number;
  target: number;
}

function shiftDay(day: string, delta: number): string {
  const [y = 0, m = 1, d = 1] = day.split("-").map(Number);
  return todayStr(new Date(y, m - 1, d + delta));
}

export async function loadGoalSettings(): Promise<GoalSettings> {
  const raw = await getSetting(SETTING_KEYS.calorieTarget).catch(() => null);
  const base = raw != null ? parseFloat(raw) : NaN;
  return { base: isFinite(base) && base > 0 ? base : null };
}

/**
 * One day's calorie budget, or null when no base target is configured (the
 * Diary hides the card then).
 */
export async function getDayGoal(
  day: string,
  settings?: GoalSettings,
): Promise<DayGoal | null> {
  const s = settings ?? (await loadGoalSettings());
  if (s.base == null) return null;
  const rows = await listDayGoalAdjustments(day, day);
  const manual = rows[0]?.delta_kcal ?? 0;
  return {
    day,
    base: s.base,
    manual,
    target: Math.max(MIN_DAY_TARGET, s.base + manual),
  };
}

/** The budget for a multi-day period: base × days plus the corrections in it. */
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
