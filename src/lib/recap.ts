/**
 * Weekly and monthly recaps.
 *
 * The Diary's week/month totals answer "how much"; a recap answers "how did
 * it go": how many days were kept, what the training, fasting, sleep and body
 * numbers came to, and how that compares with the period before — plus the
 * highlights (longest run, longest fast, most-logged meals, badges, how you
 * felt). Everything is derived from the diary on demand; nothing is stored
 * but which finished recaps have already been seen.
 *
 * Weeks run Monday to Sunday, as on the Diary. A period still in progress is
 * recapped "so far" and compared with the same number of days of the one
 * before, so Wednesday isn't measured against a whole week.
 */
import {
  getSetting,
  listAllFasts,
  listFoodEntriesForRange,
  listHealthMetricsForRange,
  listSleepForRange,
  listStateLogsForRange,
  listUnlockedAchievements,
  listWorkoutsForRange,
  setSetting,
  todayStr,
} from "./db";
import { dayOf, shiftDay } from "./daystamp";
import { collectLoggedDays } from "./streak";
import { ACHIEVEMENTS_BY_KEY } from "./achievements";
import { RecapSeenSchema, parseJson } from "./schemas";
import { SETTING_KEYS } from "./types";
import type { Fast } from "./types";

export type RecapPeriod = "week" | "month";

/** A calendar week (Mon–Sun) or month, both bounds inclusive. */
export interface RecapRange {
  period: RecapPeriod;
  start: string;
  end: string;
}

/** The numbers that get compared with the period before. */
export interface RecapStats {
  /** Days counted — the whole period, or the elapsed part of a current one. */
  days: number;
  daysLogged: number;
  /** Average kcal eaten, over the days that have food on them. */
  avgKcal: number | null;
  avgProteinG: number | null;
  workouts: number;
  workoutKcal: number;
  /** Hours fasted inside the period (a fast crossing its edge is clipped). */
  fastHours: number;
  /** Average night, in minutes, over the nights synced. */
  avgSleepMin: number | null;
  avgSteps: number | null;
  /** Last synced weight minus the first, when there are two readings. */
  weightDeltaKg: number | null;
  avgRestingHr: number | null;
}

export interface Recap {
  range: RecapRange;
  /** Last day counted: `range.end`, or today while the period runs. */
  through: string;
  inProgress: boolean;
  stats: RecapStats;
  /** The period before, cut to the same length; null when nothing was logged in it. */
  previous: RecapStats | null;
  /** Calories eaten per counted day, null for a day with no food. */
  dailyKcal: { day: string; kcal: number | null }[];
  /** Longest run of consecutive logged days inside the period. */
  longestRun: number;
  longestFastH: number;
  /** Meals logged more than once, most frequent first. */
  topMeals: { title: string; count: number }[];
  /** States logged, most frequent first. */
  states: { label: string; icon: string | null; count: number }[];
  /** Achievements unlocked inside the period. */
  badges: { key: string; emoji: string; title: string }[];
}

// ---------------------------------------------------------------------------
// Ranges
// ---------------------------------------------------------------------------

function parts(day: string): [number, number, number] {
  const [y = 0, m = 1, d = 1] = day.split("-").map(Number);
  return [y, m, d];
}

function ymd(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Inclusive count of days from `start` to `end`. */
function daysBetween(start: string, end: string): number {
  const [ys, ms, ds] = parts(start);
  const [ye, me, de] = parts(end);
  return Math.round((Date.UTC(ye, me - 1, de) - Date.UTC(ys, ms - 1, ds)) / 86_400_000) + 1;
}

/** The week or month containing `day`. */
export function recapRangeOf(period: RecapPeriod, day: string): RecapRange {
  const [y, m, d] = parts(day);
  if (period === "week") {
    const monOffset = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
    const start = shiftDay(day, -monOffset);
    return { period, start, end: shiftDay(start, 6) };
  }
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { period, start: ymd(y, m, 1), end: ymd(y, m, last) };
}

/** The range `delta` weeks/months away from `range`. */
export function shiftRecapRange(range: RecapRange, delta: number): RecapRange {
  if (range.period === "week") return recapRangeOf("week", shiftDay(range.start, 7 * delta));
  const [y, m] = parts(range.start);
  const first = new Date(Date.UTC(y, m - 1 + delta, 1));
  return recapRangeOf("month", first.toISOString().slice(0, 10));
}

/** The last week/month that has fully ended. */
export function lastFinishedRange(period: RecapPeriod, today = todayStr()): RecapRange {
  return recapRangeOf(period, shiftDay(recapRangeOf(period, today).start, -1));
}

function utcDate(day: string): Date {
  const [y, m, d] = parts(day);
  return new Date(Date.UTC(y, m - 1, d));
}

/** "Sep 15 – 21", "Sep 29 – Oct 5" or "September 2026". */
export function recapTitle(range: RecapRange): string {
  const opts = { timeZone: "UTC" } as const;
  if (range.period === "month") {
    return utcDate(range.start).toLocaleDateString(undefined, {
      ...opts,
      month: "long",
      year: "numeric",
    });
  }
  const start = utcDate(range.start);
  const end = utcDate(range.end);
  const startLabel = start.toLocaleDateString(undefined, { ...opts, month: "short", day: "numeric" });
  const endLabel =
    start.getUTCMonth() === end.getUTCMonth()
      ? end.toLocaleDateString(undefined, { ...opts, day: "numeric" })
      : end.toLocaleDateString(undefined, { ...opts, month: "short", day: "numeric" });
  return `${startLabel} – ${endLabel}`;
}

/** Short x-axis label for one day of the chart: "Mon" in a week, "15" in a month. */
export function recapDayLabel(period: RecapPeriod, day: string): string {
  if (period === "month") return String(parts(day)[2]);
  return utcDate(day).toLocaleDateString(undefined, { timeZone: "UTC", weekday: "short" });
}

// ---------------------------------------------------------------------------
// Building one
// ---------------------------------------------------------------------------

function average(values: number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

/** Local midnight at the start of `day`, as an instant. */
function startOfDay(day: string): number {
  const [y, m, d] = parts(day);
  return new Date(y, m - 1, d).getTime();
}

/** Hours of `fast` that fall inside [from, to). */
function fastHoursWithin(f: Fast, from: number, to: number): number {
  const start = Math.max(from, new Date(f.started_at).getTime());
  const end = Math.min(to, f.ended_at ? new Date(f.ended_at).getTime() : Date.now());
  return Math.max(0, end - start) / 3_600_000;
}

function longestRunWithin(days: Set<string>, start: string, end: string): number {
  let best = 0;
  let run = 0;
  for (let d = start; d <= end; d = shiftDay(d, 1)) {
    run = days.has(d) ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return best;
}

interface Loaded {
  loggedDays: Set<string>;
  fasts: Fast[];
}

async function statsFor(start: string, through: string, shared: Loaded) {
  const [entries, workouts, sleep, metrics] = await Promise.all([
    listFoodEntriesForRange(start, through),
    listWorkoutsForRange(start, through),
    listSleepForRange(start, through),
    listHealthMetricsForRange(start, through),
  ]);

  const kcalByDay = new Map<string, number>();
  const proteinByDay = new Map<string, number>();
  for (const e of entries) {
    const d = e.day ?? dayOf(e.eaten_at, e.tz_offset_min);
    kcalByDay.set(d, (kcalByDay.get(d) ?? 0) + (e.nutrients.calories ?? 0));
    proteinByDay.set(d, (proteinByDay.get(d) ?? 0) + (e.nutrients.protein_g ?? 0));
  }

  // A night belongs to the morning it ended; naps on the same day add up.
  const sleepByDay = new Map<string, number>();
  for (const s of sleep) {
    const d = s.day ?? dayOf(s.ended_at, s.tz_offset_min);
    sleepByDay.set(d, (sleepByDay.get(d) ?? 0) + s.duration_min);
  }

  // Metrics arrive newest first.
  const weights = metrics.flatMap((m) => (m.weight_kg != null ? [m.weight_kg] : []));
  const newestWeight = weights[0];
  const oldestWeight = weights[weights.length - 1];

  let daysLogged = 0;
  for (let d = start; d <= through; d = shiftDay(d, 1)) if (shared.loggedDays.has(d)) daysLogged++;

  const from = startOfDay(start);
  const to = startOfDay(shiftDay(through, 1));

  const stats: RecapStats = {
    days: daysBetween(start, through),
    daysLogged,
    avgKcal: average([...kcalByDay.values()]),
    avgProteinG: average([...proteinByDay.values()]),
    workouts: workouts.length,
    workoutKcal: workouts.reduce((acc, w) => acc + w.calories_burned, 0),
    fastHours: shared.fasts.reduce((acc, f) => acc + fastHoursWithin(f, from, to), 0),
    avgSleepMin: average([...sleepByDay.values()]),
    avgSteps: average(metrics.flatMap((m) => (m.steps != null && m.steps > 0 ? [m.steps] : []))),
    weightDeltaKg:
      weights.length >= 2 && newestWeight != null && oldestWeight != null
        ? newestWeight - oldestWeight
        : null,
    avgRestingHr: average(metrics.flatMap((m) => (m.resting_hr != null ? [m.resting_hr] : []))),
  };
  return { stats, entries, kcalByDay, from, to };
}

/** Everything the recap sheet shows for one week or month. */
export async function buildRecap(range: RecapRange): Promise<Recap> {
  const today = todayStr();
  const inProgress = range.start <= today && today <= range.end;
  const through = inProgress ? today : range.end;

  const [loggedDays, fasts, unlocked, stateLogs] = await Promise.all([
    collectLoggedDays(),
    listAllFasts(),
    listUnlockedAchievements(),
    listStateLogsForRange(range.start, through),
  ]);
  const shared: Loaded = { loggedDays, fasts };

  const current = await statsFor(range.start, through, shared);

  // The period before, cut to as many days as this one has had so far.
  const prevRange = shiftRecapRange(range, -1);
  const prevThroughFull = shiftDay(prevRange.start, current.stats.days - 1);
  const prevThrough = prevThroughFull < prevRange.end ? prevThroughFull : prevRange.end;
  const prev = await statsFor(prevRange.start, prevThrough, shared);

  const dailyKcal: Recap["dailyKcal"] = [];
  for (let d = range.start; d <= through; d = shiftDay(d, 1)) {
    dailyKcal.push({ day: d, kcal: current.kcalByDay.get(d) ?? null });
  }

  // Meals by name, keeping the most recent spelling (entries are newest first).
  const meals = new Map<string, { title: string; count: number }>();
  for (const e of current.entries) {
    const key = e.title.trim().toLowerCase();
    if (!key) continue;
    const seen = meals.get(key);
    if (seen) seen.count++;
    else meals.set(key, { title: e.title.trim(), count: 1 });
  }
  const topMeals = [...meals.values()]
    .filter((m) => m.count >= 2)
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);

  const stateCounts = new Map<string, { label: string; icon: string | null; count: number }>();
  for (const l of stateLogs) {
    const seen = stateCounts.get(l.label);
    if (seen) seen.count++;
    else stateCounts.set(l.label, { label: l.label, icon: l.icon, count: 1 });
  }
  const states = [...stateCounts.values()].sort((a, b) => b.count - a.count).slice(0, 5);

  const badges: Recap["badges"] = [];
  for (const [key, at] of unlocked) {
    const d = dayOf(at);
    const def = ACHIEVEMENTS_BY_KEY.get(key);
    if (def && d >= range.start && d <= through) {
      badges.push({ key, emoji: def.emoji, title: def.title });
    }
  }

  const longestFastH = fasts.reduce(
    (best, f) => Math.max(best, fastHoursWithin(f, current.from, current.to)),
    0,
  );

  return {
    range,
    through,
    inProgress,
    stats: current.stats,
    previous: prev.stats.daysLogged > 0 ? prev.stats : null,
    dailyKcal,
    longestRun: longestRunWithin(loggedDays, range.start, through),
    longestFastH,
    topMeals,
    states,
    badges,
  };
}

// ---------------------------------------------------------------------------
// "Your recap is ready"
// ---------------------------------------------------------------------------

type RecapSeen = Record<RecapPeriod, string | null>;

async function loadSeen(): Promise<RecapSeen> {
  const raw = await getSetting(SETTING_KEYS.recapSeen).catch(() => null);
  if (!raw) return { week: null, month: null };
  try {
    return RecapSeenSchema.parse(parseJson(raw));
  } catch {
    return { week: null, month: null };
  }
}

/** Remember that the recap for `range` was seen, so it isn't offered again. */
export async function markRecapSeen(range: RecapRange): Promise<void> {
  const seen = await loadSeen();
  const last = seen[range.period];
  if (last != null && last >= range.start) return;
  seen[range.period] = range.start;
  await setSetting(SETTING_KEYS.recapSeen, JSON.stringify(seen)).catch(() => {
    /* non-fatal: offered once more */
  });
}

/**
 * The finished week or month whose recap hasn't been looked at yet, if any —
 * the month first, since it's the rarer one. A period with nothing logged in
 * it has nothing to recap and is skipped.
 */
export async function pendingRecap(): Promise<RecapRange | null> {
  const seen = await loadSeen();
  for (const period of ["month", "week"] as const) {
    const range = lastFinishedRange(period);
    const last = seen[period];
    if (last != null && last >= range.start) continue;
    const [entries, workouts] = await Promise.all([
      listFoodEntriesForRange(range.start, range.end),
      listWorkoutsForRange(range.start, range.end),
    ]);
    if (entries.length > 0 || workouts.some((w) => w.source == null)) return range;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Handing it to the coach
// ---------------------------------------------------------------------------

function hm(min: number): string {
  return `${Math.floor(min / 60)}h ${String(Math.round(min % 60)).padStart(2, "0")}m`;
}

/**
 * The recap as a message to the coach: the numbers it would otherwise have
 * to look up, and the question. It has the tools to dig further.
 */
export function recapCoachPrompt(r: Recap): string {
  const s = r.stats;
  const what = r.range.period === "week" ? "week" : "month";
  const lines = [
    `Here's my ${what} (${recapTitle(r.range)}${r.inProgress ? ", so far" : ""}):`,
    `- Logged ${s.daysLogged} of ${s.days} days; longest run ${r.longestRun} days.`,
  ];
  if (s.avgKcal != null) {
    lines.push(
      `- About ${Math.round(s.avgKcal)} kcal eaten per logged day` +
        (s.avgProteinG != null ? `, ${Math.round(s.avgProteinG)} g protein.` : "."),
    );
  }
  if (s.workouts > 0) {
    lines.push(`- ${s.workouts} workouts, ${Math.round(s.workoutKcal)} kcal burned.`);
  }
  if (s.fastHours >= 1) {
    lines.push(`- ${Math.round(s.fastHours)} hours fasted; longest fast ${Math.round(r.longestFastH)} h.`);
  }
  if (s.avgSleepMin != null) lines.push(`- Average night ${hm(s.avgSleepMin)}.`);
  if (s.avgSteps != null) lines.push(`- About ${Math.round(s.avgSteps)} steps a day.`);
  if (s.weightDeltaKg != null) {
    lines.push(`- Weight ${s.weightDeltaKg >= 0 ? "+" : ""}${s.weightDeltaKg.toFixed(1)} kg.`);
  }
  if (r.states.length > 0) {
    lines.push(`- How I felt: ${r.states.map((x) => `${x.label} ×${x.count}`).join(", ")}.`);
  }
  lines.push(
    "",
    `Look back at this ${what} with me: what went well, what didn't, and one thing to focus on next ${what}.`,
  );
  return lines.join("\n");
}
