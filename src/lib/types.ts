import type { ExperimentArm, ExperimentMeasure, TrialRatings } from "./schemas";

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
  /** The marine omega-3s (fish, fish oil, algae) — the part the body uses. */
  | "epa_dha_g"
  | "omega6_g"
  /** Grams of ethanol (7 kcal/g). */
  | "alcohol_g"
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
  | "beta_alanine_g"
  | "caffeine_mg";

import type { DocumentValue } from "./schemas";

/** Sparse map of nutrient amounts. Missing key = unknown / not estimated. */
export type Nutrients = Partial<Record<NutrientKey, number>>;

/** A meal kept for reuse (the `saved_meals` table). */
export interface SavedMeal {
  id: number;
  name: string;
  description: string | null;
  /** Totals for one portion. */
  nutrients: Nutrients;
  icon: string | null;
  source_entry_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface FoodEntry {
  id: number;
  /** ISO 8601 UTC timestamp of when the food was eaten. */
  eaten_at: string;
  title: string;
  description: string | null;
  /** Filename of a row in the `photos` table (not a full path). */
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
  /**
   * Why this entry doesn't break a fast — set by the diary agent (judged
   * against the running fast's purpose) or by the user. Non-null exempts this
   * one entry from fasting checks (anchor and in-fast warning); null means it
   * counts as eating, whatever its calories.
   */
  fast_ok_note: string | null;
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
  /** What the fast is for, in the user's words; null = a plain fast. */
  purpose: string | null;
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
  /** Filename of a row in the `photos` table (the screenshot), if any. */
  photo_path: string | null;
  /** Energy burned — subtracted from the day's calorie total. */
  calories_burned: number;
  duration_min: number | null;
  /** Explicitly recorded Zone 2 minutes; null means unknown. */
  zone2_min: number | null;
  /**
   * Counts as cardio: its duration counts toward the cardio goal. Switched by
   * the user, or by the Zone 2 rule until they do (see `cardio_by_hand`).
   */
  cardio: boolean;
  /** The user flipped the cardio switch themselves; the Zone 2 rule won't touch it. */
  cardio_by_hand: boolean;
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

/** One of the states they keep an eye on (see lib/states.ts). */
export interface StateCategory {
  id: number;
  label: string;
  /** The emoji itself, picked by the model when the category was created. */
  icon: string;
  created_at: string;
}

/**
 * A state that was logged: how they felt, when.
 *
 * `label` and `icon` are copied from the category it was logged under (see
 * lib/states.ts) rather than pointing at it: a row is a record of a day, so
 * renaming or removing a category later must not rewrite what was felt then.
 * The note is whatever else they wanted to say about it.
 */
export interface StateLog {
  id: number;
  /** ISO 8601 UTC timestamp. */
  logged_at: string;
  label: string;
  icon: string | null;
  note: string | null;
  /** Local day it happened on, stamped where it happened. */
  day: string;
  /** Minutes east of UTC at that moment. */
  tz_offset_min: number;
}

/** What a blood meter strip measured (see lib/readings.ts). */
export type ReadingKind = "glucose" | "ketone";

/** One finger-prick reading off a blood meter. */
export interface BloodReading {
  id: number;
  /** ISO 8601 UTC timestamp. */
  measured_at: string;
  kind: ReadingKind;
  /** mmol/L, for both kinds — mg/dL is only ever a way of showing glucose. */
  value: number;
  note: string | null;
  /** Local day it was measured on, stamped where it happened. */
  day: string;
  /** Minutes east of UTC at that moment. */
  tz_offset_min: number;
  /** The photo of the meter screen it was read from, if there was one. */
  photo_path: string | null;
}

/** Which kind of diary entry a coach note is attached to. */
export type NotedEntryKind = "meal" | "workout" | "reading" | "state" | "performance" | "sleep";

/** A note the coach attached to a diary entry (see db/schema.ts entry_notes). */
export interface EntryNote {
  id: number;
  entry_kind: NotedEntryKind;
  entry_id: number;
  text: string;
  created_at: string;
}

/** One number off a performance screen (see lib/performance.ts). */
export interface PerformanceStat {
  id: number;
  log_id: number;
  /** Catalogue key ("ftp", "vo2max", …) or a slug of the label. */
  metric: string;
  label: string;
  /** In `unit`; paces and times are seconds. */
  value: number;
  unit: string | null;
}

/** A screenshot (or note) of performance stats, with the numbers it showed. */
export interface PerformanceLog {
  id: number;
  /** ISO 8601 UTC timestamp. */
  measured_at: string;
  title: string;
  note: string | null;
  photo_path: string | null;
  model_id: string | null;
  /** Local day it was measured on, stamped where it happened. */
  day: string;
  /** Minutes east of UTC at that moment. */
  tz_offset_min: number;
  stats: PerformanceStat[];
}

/** The kinds of entry you can hold a conversation with. */
export type EntryKind = "meal" | "workout";

/**
 * One message in the conversation on an entry's page.
 *
 * `changes` is what that message did to the entry, worded for reading months
 * later — the thread is the only record of why a number moved. It is empty for
 * every message that only asked or only answered, which is most of them.
 */
export interface EntryMessage {
  id: number;
  role: "user" | "assistant";
  text: string;
  changes: string[];
  /** The entry as it stood before this message, when it rewrote one. */
  before: FoodEntry | Workout | null;
  created_at: string;
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

/** A progress selfie (Summary → Progress photos). */
export interface ProgressPhoto {
  id: number;
  /** ISO 8601 UTC timestamp of when it was taken. */
  taken_at: string;
  /** Local day it was taken on. */
  day: string;
  tz_offset_min: number;
  /** Filename of a row in the `photos` table. */
  photo_path: string;
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
  /** Filename of a row in the `photos` table; the first page. */
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

/** A situation the app can tell it's in by itself (see lib/manuals.ts). */
export type ManualTrigger = "fasting";

/** Who wrote a manual's current version. */
export type ManualAuthor = "coach" | "you";

/** A page of what works for this person in one situation (see lib/manuals.ts). */
export interface Manual {
  id: number;
  title: string;
  /** One line: when it applies. */
  situation: string;
  /** Loaded automatically while the app sees this; null when it can't tell. */
  applies_when: ManualTrigger | null;
  /** Markdown. */
  body: string;
  edited_by: ManualAuthor;
  created_at: string;
  updated_at: string;
}

/** An earlier version of a manual, kept when it changed. */
export interface ManualRevision {
  id: number;
  manual_id: number;
  title: string;
  situation: string;
  body: string;
  edited_by: ManualAuthor;
  written_at: string;
}

/** Where an experiment stands (see lib/experiments.ts). */
export type ExperimentStatus = "running" | "concluded" | "dropped";

/** Who picks the next trial's option. */
export type ExperimentAssignment = "balanced" | "choose";

/** Something that might work, under test (see lib/experiments.ts). */
export interface Experiment {
  id: number;
  title: string;
  hypothesis: string;
  /** "fasting": every fast that ends while it runs is a trial. */
  applies_when: ManualTrigger | null;
  arms: ExperimentArm[];
  measures: ExperimentMeasure[];
  assignment: ExperimentAssignment;
  target_per_arm: number;
  status: ExperimentStatus;
  conclusion: string | null;
  manual_id: number | null;
  created_at: string;
  updated_at: string;
  ended_at: string | null;
}

/** One go at an experiment. */
export interface ExperimentTrial {
  id: number;
  experiment_id: number;
  arm: string;
  fast_id: number | null;
  started_at: string;
  day: string;
  tz_offset_min: number;
  /** Null until rated. */
  ratings: TrialRatings | null;
  note: string | null;
  excluded: boolean;
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
  /** Model the coach chats with; absent/empty = the vision model (see lib/coachModel.ts). */
  coachModel: "coach_model",
  /** Model the coach's check-ins run on; absent/empty = the coach model. */
  checkinModel: "coach_checkin_model",
  /** How hard a thinking model may think for the coach: empty (its default), "low" or "none". */
  coachReasoning: "coach_reasoning",
  /** Most the check-ins may spend per local day, USD; absent/empty = no cap. */
  checkinDailyBudget: "coach_checkin_budget_usd",
  modelsCache: "models_cache",
  modelsCacheAt: "models_cache_at",
  fastDefaultHours: "fast_default_hours",
  /** Personal caffeine half-life in hours (DEFAULT_CAFFEINE_HALF_LIFE_H when absent). */
  caffeineHalfLife: "caffeine_half_life_h",
  /** Hours of sleep a night the sleep-debt card counts against (SLEEP.defaultNeedH when absent). */
  sleepNeed: "sleep_need_h",
  zone2WeeklyTarget: "zone2_weekly_target",
  /** Cardio goal in minutes per 7 days (DEFAULT_CARDIO_TARGET_MIN when absent). */
  cardioWeeklyTarget: "cardio_weekly_target_min",
  /**
   * Percent of a Garmin activity's heart-rate time in Zone 2 at which it counts
   * as cardio on its own (DEFAULT_CARDIO_ZONE2_SHARE_PCT when absent, "off" = never).
   */
  cardioZone2Share: "cardio_zone2_share_pct",
  /** Daily protein goal in grams (DEFAULT_PROTEIN_TARGET_G when absent). */
  proteinTarget: "protein_target_g",
  healthConnectLastSyncAt: "health_connect_last_sync_at",
  /** Set once a sync ran WITH history permission — gates the one-time backfill. */
  healthConnectHistorySynced: "health_connect_history_synced",
  /** Sync-logic version of the last full resync (see RESYNC_VERSION). */
  healthConnectResyncVersion: "health_connect_resync_version",
  /** Garmin Connect sync (lib/garmin.ts) — when it last finished. */
  garminLastSyncAt: "garmin_last_sync_at",
  /** Garmin's displayName for the signed-in user (some endpoints need it). */
  garminDisplayName: "garmin_display_name",
  /** "1" once the whole activity history has been read and linked. */
  garminActivitiesBackfilled: "garmin_activities_backfilled",
  /** Latest day of wellness data read ("YYYY-MM-DD"). */
  garminWellnessThrough: "garmin_wellness_through",
  /** Earliest day of wellness data read so far — the backfill's bookmark. */
  garminWellnessBackTo: "garmin_wellness_back_to",
  /** ISO time a rate-limit pause ends; no requests until then. */
  garminPausedUntil: "garmin_paused_until",
  ketoNetCarbLimit: "keto_net_carb_limit_g",
  /** Daily calorie budget (net kcal). Absent = no target set. */
  calorieTarget: "calorie_target_kcal",
  /** JSON blob of streak-freeze bookkeeping (see lib/streak.ts). */
  streakState: "streak_state",
  /** JSON blob: what the coach is pushing for and how (see lib/coach.ts). */
  coachStance: "coach_stance",
  /** JSON blob: which check-ins fire, when, and at what threshold. */
  coachTriggers: "coach_triggers",
  /**
   * Local hour (0-23) the scheduled Android check-in wakes up at. A new key
   * since the check-in moved to the morning, so an hour saved for the old
   * evening close-out doesn't keep waking it at night.
   */
  coachCheckinHour: "coach_morning_hour",
  /**
   * The clock-independent half of the coach prompt, cached for the Android
   * worker — it has no JavaScript to build one with (see lib/coach.ts).
   */
  coachPromptPrefix: "coach_prompt_prefix",
  /**
   * Id of the check-in chat the user hasn't opened yet. Written by both the
   * in-app run and the Android worker, which is the only way the app can find
   * out that the coach said something while it was closed.
   */
  coachUnreadChat: "coach_unread_chat",
  /** JSON blob: the last finished week/month whose recap was seen (see lib/recap.ts). */
  recapSeen: "recap_seen",
  /**
   * Country product lookups search first: an ISO code ("dk"), "world" for no
   * country, absent/empty = the phone's region (see lib/openFoodFacts.ts).
   */
  foodCountry: "food_country",
  /** "mmol" | "mgdl": how glucose readings are typed in and shown. */
  glucoseUnit: "glucose_unit",
} as const;

export const DEFAULT_VISION_MODEL = "google/gemini-2.5-flash";
export const DEFAULT_FAST_HOURS = 16;
/** Cardio goal, minutes per 7 days, until another is stored. */
export const DEFAULT_CARDIO_TARGET_MIN = 300;
/** A Garmin activity with at least this share of its HR time in Zone 2 counts as cardio. */
export const DEFAULT_CARDIO_ZONE2_SHARE_PCT = 50;
/** Daily protein goal, in grams, until another is stored. */
export const DEFAULT_PROTEIN_TARGET_G = 150;
/** Daily net-carb budget (g) that keeps most people in ketosis. */
export const DEFAULT_KETO_NET_CARB_LIMIT_G = 25;
