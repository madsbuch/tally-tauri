/**
 * Achievements engine.
 *
 * 30 achievements over the data Tally already collects: diary logging,
 * AI captures, fasting, nutrition quality, workouts and Garmin-synced body
 * metrics. Deliberately NO daily-calorie-budget achievements — fasting two
 * days and eating the calories later in the week is a valid pattern here.
 *
 * Most achievements are data-driven: `scanAchievements()` re-derives them
 * from the database, so history counts and nothing is lost if a scan is
 * missed. A few (marked event-only) can only be detected the moment they
 * happen — the diary agent calls `unlockAchievement()` directly for those.
 */
import {
  insertAchievement,
  listAllFasts,
  listAllFoodEntries,
  listAllHealthMetrics,
  listAllSleepSessions,
  listAllSupplementLogs,
  listAllWorkouts,
  listUnlockedAchievements,
  todayStr,
} from "./db";
import { REFERENCE_INTAKES, nutrientDef, scaleNutrients, sumNutrients } from "./nutrients";
import { getStreakInfo } from "./streak";
import type { StreakInfo } from "./streak";
import type {
  Fast,
  FoodEntry,
  HealthMetric,
  NutrientKey,
  Nutrients,
  SleepSession,
  SupplementLogWithSupplement,
  Workout,
} from "./types";

export const ACHIEVEMENT_UNLOCKED_EVENT = "tally:achievement-unlocked";

export type AchievementCategory =
  | "logging"
  | "capture"
  | "fasting"
  | "nutrition"
  | "training"
  | "body";

export const CATEGORY_LABELS: Record<AchievementCategory, string> = {
  logging: "Logging",
  capture: "Smart captures",
  fasting: "Fasting",
  nutrition: "Nutrition",
  training: "Training",
  body: "Body & recovery",
};

export interface AchievementDef {
  key: string;
  emoji: string;
  title: string;
  description: string;
  category: AchievementCategory;
  /** Absent = event-only: unlocked via unlockAchievement() at the moment it happens. */
  check?: (ctx: ScanContext) => Promise<boolean>;
}

const HOUR_MS = 3_600_000;

function dayOf(iso: string): string {
  return todayStr(new Date(iso));
}

/** Shift a "YYYY-MM-DD" local day string by whole days. */
function shiftDay(day: string, delta: number): string {
  const [y = 0, m = 1, d = 1] = day.split("-").map(Number);
  return todayStr(new Date(y, m - 1, d + delta));
}

/** Longest consecutive-day run within a set of "YYYY-MM-DD" strings. */
function longestRun(days: Set<string>): number {
  let best = 0;
  for (const d of days) {
    if (days.has(shiftDay(d, -1))) continue;
    let len = 1;
    let cur = d;
    while (days.has(shiftDay(cur, 1))) {
      cur = shiftDay(cur, 1);
      len++;
    }
    best = Math.max(best, len);
  }
  return best;
}

/** Elapsed hours of a fast — completed ones by their end, active ones by now. */
function fastHours(f: Fast): number {
  const end = f.ended_at ? new Date(f.ended_at).getTime() : Date.now();
  return Math.max(0, end - new Date(f.started_at).getTime()) / HOUR_MS;
}

/**
 * Shared, lazily-loaded data for one scan pass — each dataset is fetched at
 * most once no matter how many checks consume it.
 */
class ScanContext {
  private cache = new Map<string, Promise<unknown>>();

  private memo<T>(key: string, load: () => Promise<T>): Promise<T> {
    let p = this.cache.get(key) as Promise<T> | undefined;
    if (!p) {
      p = load();
      this.cache.set(key, p);
    }
    return p;
  }

  streak(): Promise<StreakInfo> {
    return this.memo("streak", getStreakInfo);
  }
  foodEntries(): Promise<FoodEntry[]> {
    return this.memo("food", listAllFoodEntries);
  }
  workouts(): Promise<Workout[]> {
    return this.memo("workouts", listAllWorkouts);
  }
  suppLogs(): Promise<SupplementLogWithSupplement[]> {
    return this.memo("supps", listAllSupplementLogs);
  }
  fasts(): Promise<Fast[]> {
    return this.memo("fasts", listAllFasts);
  }
  sleep(): Promise<SleepSession[]> {
    return this.memo("sleep", listAllSleepSessions);
  }
  metrics(): Promise<HealthMetric[]> {
    return this.memo("metrics", listAllHealthMetrics);
  }

  /** Per-day nutrient totals (food + supplements), keyed by local day. */
  dayNutrients(): Promise<Map<string, Nutrients>> {
    return this.memo("dayNutrients", async () => {
      const [entries, supps] = await Promise.all([this.foodEntries(), this.suppLogs()]);
      const byDay = new Map<string, Nutrients[]>();
      const push = (day: string, n: Nutrients) => {
        const list = byDay.get(day);
        if (list) list.push(n);
        else byDay.set(day, [n]);
      };
      for (const e of entries) push(dayOf(e.eaten_at), e.nutrients);
      for (const l of supps) push(dayOf(l.taken_at), scaleNutrients(l.nutrients, l.amount));
      const out = new Map<string, Nutrients>();
      for (const [day, list] of byDay) out.set(day, sumNutrients(list));
      return out;
    });
  }

  /** Most recent synced body weight, or null if never synced. */
  async latestWeightKg(): Promise<number | null> {
    const metrics = await this.metrics(); // newest first
    for (const m of metrics) if (m.weight_kg != null) return m.weight_kg;
    return null;
  }
}

async function someDay(
  ctx: ScanContext,
  pred: (n: Nutrients) => boolean,
): Promise<boolean> {
  const days = await ctx.dayNutrients();
  for (const n of days.values()) if (pred(n)) return true;
  return false;
}

export const ACHIEVEMENTS: AchievementDef[] = [
  // -- Logging habit --------------------------------------------------------
  {
    key: "first_log",
    emoji: "🌱",
    title: "First Bite",
    description: "Log your first diary item.",
    category: "logging",
    check: async (ctx) => (await ctx.streak()).totalDaysLogged >= 1,
  },
  {
    key: "first_photo",
    emoji: "📸",
    title: "Say Cheese",
    description: "Have the AI turn a photo capture into a diary entry.",
    category: "logging",
    check: async (ctx) => {
      const [entries, workouts] = await Promise.all([ctx.foodEntries(), ctx.workouts()]);
      return (
        entries.some((e) => e.photo_path && e.model_id) ||
        workouts.some((w) => w.photo_path && w.model_id)
      );
    },
  },
  {
    key: "streak_7",
    emoji: "🔥",
    title: "One Week Wonder",
    description: "Keep a 7-day logging streak.",
    category: "logging",
    check: async (ctx) => (await ctx.streak()).best >= 7,
  },
  {
    key: "streak_30",
    emoji: "🗓️",
    title: "Habit Formed",
    description: "Keep a 30-day logging streak.",
    category: "logging",
    check: async (ctx) => (await ctx.streak()).best >= 30,
  },
  {
    key: "streak_90",
    emoji: "🏛️",
    title: "Quarter Club",
    description: "Keep a 90-day logging streak.",
    category: "logging",
    check: async (ctx) => (await ctx.streak()).best >= 90,
  },
  {
    key: "days_100",
    emoji: "💯",
    title: "Century of Days",
    description: "Log on 100 different days.",
    category: "logging",
    check: async (ctx) => (await ctx.streak()).totalDaysLogged >= 100,
  },
  {
    key: "days_365",
    emoji: "📚",
    title: "A Year in the Books",
    description: "Log on 365 different days.",
    category: "logging",
    check: async (ctx) => (await ctx.streak()).totalDaysLogged >= 365,
  },

  // -- Smart captures (event-only: captures dissolve once resolved) ---------
  {
    key: "combo_capture",
    emoji: "🪄",
    title: "Three Birds, One Photo",
    description: "One capture resolved into three or more diary entries.",
    category: "capture",
  },
  {
    key: "quick_draw",
    emoji: "⚡",
    title: "Hot off the Plate",
    description: "Capture a meal within 10 minutes of eating it.",
    category: "capture",
  },
  {
    key: "full_day",
    emoji: "🧩",
    title: "The Full Picture",
    description: "One day with a meal, a workout, a supplement and synced sleep.",
    category: "capture",
    check: async (ctx) => {
      const [entries, workouts, supps, sleep] = await Promise.all([
        ctx.foodEntries(),
        ctx.workouts(),
        ctx.suppLogs(),
        ctx.sleep(),
      ]);
      const mealDays = new Set(entries.map((e) => dayOf(e.eaten_at)));
      const workoutDays = new Set(workouts.map((w) => dayOf(w.performed_at)));
      const suppDays = new Set(supps.map((l) => dayOf(l.taken_at)));
      return sleep.some((s) => {
        const d = dayOf(s.ended_at);
        return mealDays.has(d) && workoutDays.has(d) && suppDays.has(d);
      });
    },
  },

  // -- Fasting --------------------------------------------------------------
  {
    key: "fast_16",
    emoji: "⏳",
    title: "First Fast",
    description: "Fast for 16 hours.",
    category: "fasting",
    check: async (ctx) => (await ctx.fasts()).some((f) => fastHours(f) >= 16),
  },
  {
    key: "fast_24",
    emoji: "🕛",
    title: "Around the Clock",
    description: "Fast for a full 24 hours.",
    category: "fasting",
    check: async (ctx) => (await ctx.fasts()).some((f) => fastHours(f) >= 24),
  },
  {
    key: "fast_48",
    emoji: "♻️",
    title: "Deep Cleanse",
    description: "Fast for 48 hours — deep autophagy territory.",
    category: "fasting",
    check: async (ctx) => (await ctx.fasts()).some((f) => fastHours(f) >= 48),
  },
  {
    key: "fast_72",
    emoji: "🧬",
    title: "Renewal",
    description: "Fast for 72 hours — the renewal stage.",
    category: "fasting",
    check: async (ctx) => (await ctx.fasts()).some((f) => fastHours(f) >= 72),
  },
  {
    key: "fast_goal_10",
    emoji: "🤝",
    title: "Promise Keeper",
    description: "Reach your fasting goal 10 times.",
    category: "fasting",
    check: async (ctx) =>
      (await ctx.fasts()).filter(
        (f) => f.ended_at != null && fastHours(f) >= f.goal_hours - 1 / 3600,
      ).length >= 10,
  },
  {
    key: "fast_hours_500",
    emoji: "⌛",
    title: "Five Hundred Hours",
    description: "Accumulate 500 lifetime fasting hours.",
    category: "fasting",
    check: async (ctx) =>
      (await ctx.fasts()).reduce((acc, f) => acc + fastHours(f), 0) >= 500,
  },

  // -- Nutrition ------------------------------------------------------------
  {
    key: "protein_target",
    emoji: "🥩",
    title: "Protein Pro",
    description: "Hit 1.6 g protein per kg body weight in one day (120 g without a synced weight).",
    category: "nutrition",
    check: async (ctx) => {
      const weight = await ctx.latestWeightKg();
      const target = weight != null ? 1.6 * weight : 120;
      return someDay(ctx, (n) => (n.protein_g ?? 0) >= target);
    },
  },
  {
    key: "fiber_35",
    emoji: "🌾",
    title: "Fiber Friend",
    description: "Eat 35 g of fiber in one day.",
    category: "nutrition",
    check: (ctx) => someDay(ctx, (n) => (n.fiber_g ?? 0) >= 35),
  },
  {
    key: "omega_balance",
    emoji: "🐟",
    title: "Omega Wisdom",
    description: "A day with at least 1 g omega-3 and a 6:3 ratio of 4 or better.",
    category: "nutrition",
    check: (ctx) =>
      someDay(ctx, (n) => {
        const o3 = n.omega3_g ?? 0;
        return o3 >= 1 && (n.omega6_g ?? 0) / o3 <= 4;
      }),
  },
  {
    key: "potassium_day",
    emoji: "🥑",
    title: "Mineral Rich",
    description: "Reach 3,500 mg of potassium in one day.",
    category: "nutrition",
    check: (ctx) => someDay(ctx, (n) => (n.potassium_mg ?? 0) >= 3500),
  },
  {
    key: "full_spectrum",
    emoji: "🌈",
    title: "Full Spectrum",
    description: "Cover 80%+ of every tracked micronutrient reference in a single day.",
    category: "nutrition",
    check: (ctx) =>
      someDay(ctx, (n) =>
        Object.entries(REFERENCE_INTAKES).every(([key, ref]) => {
          // Micros only — "other" compounds (e.g. creatine) have supplementation
          // targets, not dietary references, and shouldn't gate this.
          if (nutrientDef(key as NutrientKey).group !== "micro") return true;
          return (n[key as keyof Nutrients] ?? 0) >= 0.8 * ref;
        }),
      ),
  },
  {
    key: "supp_variety",
    emoji: "💊",
    title: "Stacked",
    description: "Log five different supplements in one day.",
    category: "nutrition",
    check: async (ctx) => {
      const logs = await ctx.suppLogs();
      const perDay = new Map<string, Set<number>>();
      for (const l of logs) {
        const d = dayOf(l.taken_at);
        const set = perDay.get(d) ?? new Set<number>();
        set.add(l.supplement_id);
        perDay.set(d, set);
      }
      return [...perDay.values()].some((s) => s.size >= 5);
    },
  },

  // -- Training -------------------------------------------------------------
  {
    key: "first_workout",
    emoji: "🏃",
    title: "Warming Up",
    description: "Log your first workout.",
    category: "training",
    check: async (ctx) => (await ctx.workouts()).length >= 1,
  },
  {
    key: "garmin_synced",
    emoji: "⌚",
    title: "Wrist Wired",
    description: "Sync your first workout from your watch.",
    category: "training",
    check: async (ctx) => (await ctx.workouts()).some((w) => w.source != null),
  },
  {
    key: "burn_1000",
    emoji: "🌋",
    title: "Furnace",
    description: "Burn 1,000 kcal in workouts in one day.",
    category: "training",
    check: async (ctx) => {
      const perDay = new Map<string, number>();
      for (const w of await ctx.workouts()) {
        const d = dayOf(w.performed_at);
        perDay.set(d, (perDay.get(d) ?? 0) + w.calories_burned);
      }
      return [...perDay.values()].some((kcal) => kcal >= 1000);
    },
  },
  {
    key: "active_week",
    emoji: "🎽",
    title: "Active Week",
    description: "Work out on five different days in one week.",
    category: "training",
    check: async (ctx) => {
      // Key each workout day by the Monday of its week.
      const perWeek = new Map<string, Set<string>>();
      for (const w of await ctx.workouts()) {
        const day = dayOf(w.performed_at);
        const [y = 0, m = 1, d = 1] = day.split("-").map(Number);
        const monOffset = (new Date(y, m - 1, d).getDay() + 6) % 7;
        const week = shiftDay(day, -monOffset);
        const set = perWeek.get(week) ?? new Set<string>();
        set.add(day);
        perWeek.set(week, set);
      }
      return [...perWeek.values()].some((days) => days.size >= 5);
    },
  },
  {
    key: "early_bird",
    emoji: "🌅",
    title: "Early Bird",
    description: "Log a workout that started before 7 in the morning.",
    category: "training",
    check: async (ctx) =>
      (await ctx.workouts()).some((w) => new Date(w.performed_at).getHours() < 7),
  },

  // -- Body & recovery (Garmin / Health Connect) ----------------------------
  {
    key: "steps_15k",
    emoji: "👣",
    title: "Wanderer",
    description: "Walk 15,000 steps in one day.",
    category: "body",
    check: async (ctx) => (await ctx.metrics()).some((m) => (m.steps ?? 0) >= 15_000),
  },
  {
    key: "steps_million",
    emoji: "🚶",
    title: "Million Steps",
    description: "Accumulate 1,000,000 synced steps.",
    category: "body",
    check: async (ctx) =>
      (await ctx.metrics()).reduce((acc, m) => acc + (m.steps ?? 0), 0) >= 1_000_000,
  },
  {
    key: "sleep_week",
    emoji: "😴",
    title: "Well Rested",
    description: "Seven nights in a row with 7+ hours of sleep.",
    category: "body",
    check: async (ctx) => {
      // A night belongs to the morning it ended; multiple sessions add up.
      const perDay = new Map<string, number>();
      for (const s of await ctx.sleep()) {
        const d = dayOf(s.ended_at);
        perDay.set(d, (perDay.get(d) ?? 0) + s.duration_min);
      }
      const good = new Set<string>();
      for (const [d, min] of perDay) if (min >= 7 * 60) good.add(d);
      return longestRun(good) >= 7;
    },
  },
];

export const ACHIEVEMENTS_BY_KEY = new Map(ACHIEVEMENTS.map((a) => [a.key, a]));

function dispatchUnlocked(keys: string[]): void {
  if (keys.length === 0) return;
  window.dispatchEvent(new CustomEvent(ACHIEVEMENT_UNLOCKED_EVENT, { detail: { keys } }));
}

export function onAchievementsUnlocked(handler: (keys: string[]) => void): () => void {
  const listener = (e: Event) => {
    const keys = (e as CustomEvent<{ keys?: string[] }>).detail?.keys;
    if (Array.isArray(keys)) handler(keys);
  };
  window.addEventListener(ACHIEVEMENT_UNLOCKED_EVENT, listener);
  return () => window.removeEventListener(ACHIEVEMENT_UNLOCKED_EVENT, listener);
}

/**
 * Unlock a single achievement right now (event-only ones, called from the
 * diary agent). No-op if already unlocked.
 */
export async function unlockAchievement(key: string): Promise<void> {
  if (!ACHIEVEMENTS_BY_KEY.has(key)) return;
  try {
    if (await insertAchievement(key, new Date().toISOString())) dispatchUnlocked([key]);
  } catch (e) {
    console.warn(`Could not unlock achievement "${key}"`, e);
  }
}

let scanInFlight: Promise<string[]> | null = null;

/**
 * Evaluate every still-locked data-driven achievement against the database
 * and unlock the ones that now hold. Returns the newly unlocked keys.
 * Concurrent calls share one pass.
 */
export function scanAchievements(): Promise<string[]> {
  if (scanInFlight) return scanInFlight;
  scanInFlight = (async () => {
    try {
      const unlocked = await listUnlockedAchievements();
      const ctx = new ScanContext();
      const fresh: string[] = [];
      for (const def of ACHIEVEMENTS) {
        if (!def.check || unlocked.has(def.key)) continue;
        try {
          if (await def.check(ctx)) {
            if (await insertAchievement(def.key, new Date().toISOString())) {
              fresh.push(def.key);
            }
          }
        } catch (e) {
          console.warn(`Achievement check "${def.key}" failed`, e);
        }
      }
      dispatchUnlocked(fresh);
      return fresh;
    } finally {
      scanInFlight = null;
    }
  })();
  return scanInFlight;
}
