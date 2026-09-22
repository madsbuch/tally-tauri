/** Fixed set of tracked nutrients. Units are encoded in the key suffix. */
export type NutrientKey =
  // Macros
  | "calories"
  | "protein_g"
  | "carbs_g"
  | "fat_g"
  | "saturated_fat_g"
  | "trans_fat_g"
  | "fiber_g"
  | "sugar_g"
  | "omega3_g"
  | "omega6_g"
  // Micros
  | "sodium_mg"
  | "potassium_mg"
  | "calcium_mg"
  | "magnesium_mg"
  | "phosphorus_mg"
  | "iron_mg"
  | "zinc_mg"
  | "copper_mg"
  | "manganese_mg"
  | "selenium_ug"
  | "iodine_ug"
  | "cholesterol_mg"
  | "vitamin_a_ug"
  | "vitamin_c_mg"
  | "vitamin_d_ug"
  | "vitamin_e_mg"
  | "vitamin_k_ug"
  | "thiamin_mg"
  | "riboflavin_mg"
  | "niacin_mg"
  | "pantothenic_acid_mg"
  | "vitamin_b6_mg"
  | "biotin_ug"
  | "vitamin_b12_ug"
  | "folate_ug"
  | "choline_mg"
  // Other compounds (no classic macro/micro role)
  | "creatine_g"
  | "caffeine_mg";

import type { DocumentValue } from "./schemas";

/** Sparse map of nutrient amounts. Missing key = unknown / not estimated. */
export type Nutrients = Partial<Record<NutrientKey, number>>;

export interface FoodEntry {
  id: number;
  /** ISO 8601 UTC timestamp of when the food was eaten. */
  eaten_at: string;
  title: string;
  description: string | null;
  /** Filename inside the app data `photos/` dir (not a full path). */
  photo_path: string | null;
  nutrients: Nutrients;
  /** OpenRouter model id that produced the estimate, if any. */
  model_id: string | null;
  /** Icon key shown when there's no photo (see lib/icons.ts); null = guess it. */
  icon: string | null;
  /**
   * Local day this happened on, stamped where it happened (see lib/daystamp.ts)
   * — null only on a row written before day stamps existed.
   */
  day: string | null;
  /** Minutes east of UTC at that moment; null means "read it here". */
  tz_offset_min: number | null;
}

export interface Supplement {
  id: number;
  name: string;
  /** Default dose, e.g. 500 (mg) or 1 (capsule). */
  dose_amount: number | null;
  dose_unit: string | null;
  /** Nutrient contribution of ONE default dose. */
  nutrients: Nutrients;
  notes: string | null;
  archived: number;
}

export interface SupplementLog {
  id: number;
  supplement_id: number;
  /** ISO 8601 UTC timestamp. */
  taken_at: string;
  /** Multiplier of the supplement's default dose (1 = one dose). */
  amount: number;
  /**
   * Local day this happened on, stamped where it happened (see lib/daystamp.ts)
   * — null only on a row written before day stamps existed.
   */
  day: string | null;
  /** Minutes east of UTC at that moment; null means "read it here". */
  tz_offset_min: number | null;
}

/** Supplement log joined with its supplement for display. */
export interface SupplementLogWithSupplement extends SupplementLog {
  name: string;
  dose_amount: number | null;
  dose_unit: string | null;
  nutrients: Nutrients;
}

export interface Fast {
  id: number;
  /** ISO 8601 UTC timestamp. */
  started_at: string;
  goal_hours: number;
  /** ISO 8601 UTC timestamp; null while the fast is active. */
  ended_at: string | null;
  /** Local day it began on; every day through `end_day` counts as fasted. */
  start_day: string | null;
  /** Local day it ended on; null while it's still running. */
  end_day: string | null;
  /** Minutes east of UTC where it started. */
  tz_offset_min: number | null;
}

/**
 * A fire-and-forget diary capture awaiting (or failed) background analysis.
 * Successful captures are deleted once the agent has logged real entries.
 */
export interface Capture {
  id: number;
  /** ISO 8601 UTC timestamp of when the capture was taken. */
  created_at: string;
  /** Local diary day ("YYYY-MM-DD") it was added to. */
  day: string;
  note: string | null;
  photo_path: string | null;
  status: "pending" | "error";
  error: string | null;
}

/** An exercise session, usually imported from a workout-app screenshot. */
export interface Workout {
  id: number;
  /** ISO 8601 UTC timestamp. */
  performed_at: string;
  title: string;
  description: string | null;
  /** Filename inside the app data `photos/` dir (the screenshot), if any. */
  photo_path: string | null;
  /** Energy burned — subtracted from the day's calorie total. */
  calories_burned: number;
  duration_min: number | null;
  model_id: string | null;
  /** Icon key shown when there's no photo (see lib/icons.ts); null = guess it. */
  icon: string | null;
  /** Where the workout came from, e.g. "Garmin" — null = manual/agent entry. */
  source: string | null;
  /** Stable id in the external system (Health Connect record UID) for dedup. */
  external_id: string | null;
  /**
   * Local day this happened on, stamped where it happened (see lib/daystamp.ts)
   * — null only on a row written before day stamps existed.
   */
  day: string | null;
  /** Minutes east of UTC at that moment; null means "read it here". */
  tz_offset_min: number | null;
}

/** A night of sleep synced from Health Connect (written by e.g. Garmin). */
export interface SleepSession {
  id: number;
  /** Health Connect record UID for dedup. */
  external_id: string;
  /** ISO 8601 UTC timestamps. */
  started_at: string;
  ended_at: string;
  duration_min: number;
  /** Stage minutes; null when the source didn't record stages. */
  deep_min: number | null;
  rem_min: number | null;
  light_min: number | null;
  awake_min: number | null;
  source: string | null;
  /** Local day the night ENDED on — the morning it belongs to. */
  day: string | null;
  /** Minutes east of UTC where it was slept. */
  tz_offset_min: number | null;
}

/**
 * One local day of wellness metrics synced from Health Connect.
 * A field is null when nothing was recorded that day.
 */
export interface HealthMetric {
  /** Local day "YYYY-MM-DD". */
  day: string;
  steps: number | null;
  resting_hr: number | null;
  /** Heart-rate variability, RMSSD in ms. */
  hrv_ms: number | null;
  /** Blood oxygen saturation in percent. */
  spo2_pct: number | null;
  weight_kg: number | null;
  vo2_max: number | null;
  /** Total energy burned that day (kcal). */
  calories_total: number | null;
  updated_at: string;
}

/** A manual correction to one day's calorie target. */
export interface DayGoalAdjustment {
  /** Local day "YYYY-MM-DD". */
  day: string;
  /** Signed kcal added to the day's target (negative = a smaller budget). */
  delta_kcal: number;
  note: string | null;
  updated_at: string;
}

/** A photographed document in the library (see lib/documents.ts). */
export interface LibraryDocument {
  id: number;
  /** ISO 8601 UTC timestamp of when it was added. */
  created_at: string;
  /** Local day the document itself refers to; null until it's been read. */
  document_date: string | null;
  title: string;
  kind: "lab" | "imaging" | "report" | "note" | "other";
  /** Filename inside the app data `photos/` dir; the first page. */
  photo_path: string | null;
  /**
   * Every page, in order. A PDF yields one image per page; a photograph one.
   * Empty on documents filed before multi-page support — use `documentPages`
   * (lib/documents.ts) rather than reading this directly.
   */
  page_paths: string[];
  note: string | null;
  summary: string | null;
  extracted: DocumentValue[];
  status: "pending" | "ready" | "error";
  error: string | null;
  model_id: string | null;
}

/** One thing the coach knows about you (see lib/coach.ts). */
export interface CoachMemory {
  id: number;
  kind: "goal" | "commitment" | "preference" | "note";
  text: string;
  /** Commitments only; null for other kinds. */
  status: "open" | "done" | "dropped" | null;
  /** Local day to revisit this on; null when there's nothing to come back to. */
  follow_up_on: string | null;
  created_at: string;
  updated_at: string;
}

/** A check-in the coach started (see lib/coachTriggers.ts). */
export interface CoachRun {
  id: number;
  trigger_key: string;
  /** Local day "YYYY-MM-DD". */
  day: string;
  created_at: string;
  chat_id: number | null;
}

/** A saved assistant conversation (without its transcript). */
export interface ChatSummary {
  id: number;
  title: string;
  /** ISO 8601 UTC timestamps. */
  created_at: string;
  updated_at: string;
}

/** Result of an AI food-photo analysis. */
export interface FoodAnalysis {
  title: string;
  description: string;
  confidence: "low" | "medium" | "high";
  nutrients: Nutrients;
}

/** Result of an AI workout-screenshot analysis. */
export interface WorkoutAnalysis {
  title: string;
  description: string;
  confidence: "low" | "medium" | "high";
  calories_burned: number;
  duration_min: number | null;
}

/** OpenRouter model listing entry (subset of the /models response). */
export type { ORModel } from "./schemas";

/** One measurement read off a document. */
export type { DocumentValue } from "./schemas";

/** Keys used in the `settings` table. */
export const SETTING_KEYS = {
  openrouterApiKey: "openrouter_api_key",
  visionModel: "vision_model",
  modelsCache: "models_cache",
  modelsCacheAt: "models_cache_at",
  fastDefaultHours: "fast_default_hours",
  healthConnectLastSyncAt: "health_connect_last_sync_at",
  /** Set once a sync ran WITH history permission — gates the one-time backfill. */
  healthConnectHistorySynced: "health_connect_history_synced",
  /** Sync-logic version of the last full resync (see RESYNC_VERSION). */
  healthConnectResyncVersion: "health_connect_resync_version",
  ketoNetCarbLimit: "keto_net_carb_limit_g",
  /** Daily calorie budget (net kcal). Absent = no target set. */
  calorieTarget: "calorie_target_kcal",
  /** JSON blob of streak-freeze bookkeeping (see lib/streak.ts). */
  streakState: "streak_state",
  /** JSON blob: what the coach is pushing for and how (see lib/coach.ts). */
  coachStance: "coach_stance",
  /** JSON blob: which check-ins fire, when, and at what threshold. */
  coachTriggers: "coach_triggers",
  /** Local hour (0-23) the scheduled Android check-in wakes up at. */
  coachCheckinHour: "coach_checkin_hour",
  /**
   * The clock-independent half of the coach prompt, cached for the Android
   * worker — it has no JavaScript to build one with (see lib/coach.ts).
   */
  coachPromptPrefix: "coach_prompt_prefix",
} as const;

export const DEFAULT_VISION_MODEL = "google/gemini-2.5-flash";
export const DEFAULT_FAST_HOURS = 16;
/**
 * Entries at or above this many kcal count as a meal for fasting purposes:
 * they anchor new fasts and break an active one. Below it (black coffee,
 * diet soda, broth) an entry can be logged mid-fast without ending it.
 * Entries with NO calorie estimate count as meals — an unestimated entry is
 * far more likely a real meal than a zero-calorie drink.
 */
export const FAST_BREAK_KCAL = 20;
/** Daily net-carb budget (g) that keeps most people in ketosis. */
export const DEFAULT_KETO_NET_CARB_LIMIT_G = 25;
