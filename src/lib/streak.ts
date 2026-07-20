/**
 * Logging-streak engine with freeze tokens.
 *
 * A day counts as "logged" when it has at least one diary item — a meal,
 * workout (Garmin included), supplement, pending capture — or is covered by
 * a fast, so multi-day fasts never break the streak. Today gets grace: an
 * empty today doesn't end the streak until the day is over.
 *
 * Freezes: every 7 consecutive days earns one freeze token (max 3 banked).
 * A missed day automatically consumes a token and the streak survives.
 * Spent freezes are remembered per-day, so recomputation is stable — and if
 * a frozen day is later backfilled with a real entry, the token is refunded.
 */
import {
  getSetting,
  listAllCaptures,
  listAllFasts,
  listAllFoodEntries,
  listAllSupplementLogs,
  listAllWorkouts,
  setSetting,
  todayStr,
} from "./db";
import { SETTING_KEYS } from "./types";

export const MAX_FREEZES = 3;
export const FREEZE_EARN_DAYS = 7;

export interface StreakInfo {
  /** Consecutive logged days ending today (or yesterday, if today is empty). */
  current: number;
  /** Longest streak ever (frozen days count). */
  best: number;
  /** Freeze tokens currently banked. */
  freezes: number;
  /** Days of the current streak covered by a spent freeze. */
  frozenDays: string[];
  todayLogged: boolean;
  /** Total distinct days with at least one log (streaks aside). */
  totalDaysLogged: number;
}

interface StreakState {
  freezes: number;
  frozenDays: string[];
  /** Streak length at which a freeze was last earned (resets on break). */
  lastEarnedStreak: number;
}

const DEFAULT_STATE: StreakState = { freezes: 0, frozenDays: [], lastEarnedStreak: 0 };

function parseState(raw: string | null): StreakState {
  if (!raw) return { ...DEFAULT_STATE };
  try {
    const p = JSON.parse(raw) as Partial<StreakState>;
    return {
      freezes: clampInt(p.freezes, 0, MAX_FREEZES),
      frozenDays: Array.isArray(p.frozenDays)
        ? p.frozenDays.filter((d): d is string => typeof d === "string")
        : [],
      lastEarnedStreak: clampInt(p.lastEarnedStreak, 0, Number.MAX_SAFE_INTEGER),
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function clampInt(v: unknown, min: number, max: number): number {
  const n = typeof v === "number" && isFinite(v) ? Math.floor(v) : min;
  return Math.min(max, Math.max(min, n));
}

/** Shift a "YYYY-MM-DD" local day string by whole days. */
function shiftDay(day: string, delta: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return todayStr(new Date(y, m - 1, d + delta));
}

function localDayOf(iso: string): string {
  return todayStr(new Date(iso));
}

/** The set of local days that have at least one diary item or fast cover. */
export async function collectLoggedDays(): Promise<Set<string>> {
  const [entries, workouts, suppLogs, captures, fasts] = await Promise.all([
    listAllFoodEntries(),
    listAllWorkouts(),
    listAllSupplementLogs(),
    listAllCaptures(),
    listAllFasts(),
  ]);
  const days = new Set<string>();
  for (const e of entries) days.add(localDayOf(e.eaten_at));
  for (const w of workouts) days.add(localDayOf(w.performed_at));
  for (const l of suppLogs) days.add(localDayOf(l.taken_at));
  for (const c of captures) days.add(c.day);
  const today = todayStr();
  for (const f of fasts) {
    // Every day the fast spans counts — deliberately not eating IS the log.
    let d = localDayOf(f.started_at);
    const end = f.ended_at ? localDayOf(f.ended_at) : today;
    for (; d <= end; d = shiftDay(d, 1)) days.add(d);
  }
  return days;
}

/** Longest consecutive run in `days` (frozen days included). */
function bestStreak(days: Set<string>, frozen: Set<string>): number {
  const all = new Set([...days, ...frozen]);
  let best = 0;
  for (const d of all) {
    if (all.has(shiftDay(d, -1))) continue; // not a run start
    let len = 1;
    let cur = d;
    while (all.has(shiftDay(cur, 1))) {
      cur = shiftDay(cur, 1);
      len++;
    }
    best = Math.max(best, len);
  }
  return best;
}

/**
 * Compute the streak, spending/earning/refunding freezes as needed, and
 * persist the updated state. Cheap enough to run on every diary change.
 */
export async function getStreakInfo(): Promise<StreakInfo> {
  const [days, rawState] = await Promise.all([
    collectLoggedDays(),
    getSetting(SETTING_KEYS.streakState).catch(() => null),
  ]);
  const state = parseState(rawState);
  const before = JSON.stringify(state);

  // Refund freezes spent on days that later got a real (backfilled) entry.
  state.frozenDays = state.frozenDays.filter((d) => {
    if (days.has(d)) {
      state.freezes = Math.min(MAX_FREEZES, state.freezes + 1);
      return false;
    }
    return true;
  });
  const frozen = new Set(state.frozenDays);

  const today = todayStr();
  const todayLogged = days.has(today);

  // Walk back from the anchor day, spending freezes on gaps. Gap days are
  // held in `pending` and only committed (tokens actually spent) when a real
  // logged day shows up deeper — freezes bridge a living streak, they never
  // burn down extending a dead one.
  let current = 0;
  if (days.size > 0) {
    const firstEver = [...days].sort()[0];
    let pending: string[] = [];
    let d = todayLogged ? today : shiftDay(today, -1);
    while (d >= firstEver) {
      if (days.has(d) || frozen.has(d)) {
        for (const p of pending) {
          state.freezes--;
          state.frozenDays.push(p);
          frozen.add(p);
        }
        current += pending.length + 1;
        pending = [];
      } else if (state.freezes > pending.length) {
        pending.push(d);
      } else {
        break;
      }
      d = shiftDay(d, -1);
    }
  }

  // Prune frozen days that are no longer part of the current streak — they
  // shouldn't resurrect a long-dead run later.
  const streakStart = shiftDay(todayLogged ? today : shiftDay(today, -1), -(current - 1));
  if (current > 0) {
    state.frozenDays = state.frozenDays.filter((d) => d >= streakStart && d <= today);
  } else {
    state.frozenDays = [];
  }

  // Earn a freeze for each full 7-day block the streak has newly crossed.
  if (current < state.lastEarnedStreak) {
    state.lastEarnedStreak = Math.floor(current / FREEZE_EARN_DAYS) * FREEZE_EARN_DAYS;
  }
  while (state.lastEarnedStreak + FREEZE_EARN_DAYS <= current) {
    state.lastEarnedStreak += FREEZE_EARN_DAYS;
    state.freezes = Math.min(MAX_FREEZES, state.freezes + 1);
  }

  if (JSON.stringify(state) !== before) {
    await setSetting(SETTING_KEYS.streakState, JSON.stringify(state)).catch(() => {
      /* non-fatal: recomputed next time */
    });
  }

  return {
    current,
    best: Math.max(current, bestStreak(days, new Set(state.frozenDays))),
    freezes: state.freezes,
    frozenDays: state.frozenDays,
    todayLogged,
    totalDaysLogged: days.size,
  };
}
