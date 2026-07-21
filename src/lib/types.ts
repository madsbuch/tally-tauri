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
  /** Where the workout came from, e.g. "Garmin" — null = manual/agent entry. */
  source: string | null;
  /** Stable id in the external system (Health Connect record UID) for dedup. */
  external_id: string | null;
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
export interface ORModel {
  id: string;
  name: string;
  description?: string;
  context_length?: number;
  created?: number;
  pricing?: {
    prompt?: string;
    completion?: string;
    image?: string;
    request?: string;
  };
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
    tokenizer?: string;
  };
  supported_parameters?: string[];
}

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
  ketoNetCarbLimit: "keto_net_carb_limit_g",
  /** Daily calorie budget (net kcal). Absent = no target set. */
  calorieTarget: "calorie_target_kcal",
  /** JSON blob of streak-freeze bookkeeping (see lib/streak.ts). */
  streakState: "streak_state",
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
