/** Fixed set of tracked nutrients. Units are encoded in the key suffix. */
export type NutrientKey =
  // Macros
  | "calories"
  | "protein_g"
  | "carbs_g"
  | "fat_g"
  | "saturated_fat_g"
  | "fiber_g"
  | "sugar_g"
  | "omega3_g"
  | "omega6_g"
  // Micros
  | "sodium_mg"
  | "potassium_mg"
  | "calcium_mg"
  | "magnesium_mg"
  | "iron_mg"
  | "zinc_mg"
  | "selenium_ug"
  | "iodine_ug"
  | "cholesterol_mg"
  | "vitamin_a_ug"
  | "vitamin_c_mg"
  | "vitamin_d_ug"
  | "vitamin_e_mg"
  | "vitamin_k_ug"
  | "vitamin_b6_mg"
  | "vitamin_b12_ug"
  | "folate_ug";

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
} as const;

export const DEFAULT_VISION_MODEL = "google/gemini-2.5-flash";
export const DEFAULT_FAST_HOURS = 16;
