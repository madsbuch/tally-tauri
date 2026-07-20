import type { NutrientKey, Nutrients } from "./types";

export interface NutrientDef {
  key: NutrientKey;
  label: string;
  unit: string;
  group: "macro" | "micro";
  /** Decimal places for display. */
  dp: number;
}

/** Canonical, ordered nutrient definitions. Display and prompts follow this order. */
export const NUTRIENT_DEFS: NutrientDef[] = [
  { key: "calories", label: "Calories", unit: "kcal", group: "macro", dp: 0 },
  { key: "protein_g", label: "Protein", unit: "g", group: "macro", dp: 1 },
  { key: "carbs_g", label: "Carbs", unit: "g", group: "macro", dp: 1 },
  { key: "fat_g", label: "Fat", unit: "g", group: "macro", dp: 1 },
  { key: "saturated_fat_g", label: "Saturated fat", unit: "g", group: "macro", dp: 1 },
  { key: "fiber_g", label: "Fiber", unit: "g", group: "macro", dp: 1 },
  { key: "sugar_g", label: "Sugar", unit: "g", group: "macro", dp: 1 },
  { key: "omega3_g", label: "Omega-3", unit: "g", group: "macro", dp: 2 },
  { key: "omega6_g", label: "Omega-6", unit: "g", group: "macro", dp: 2 },
  { key: "sodium_mg", label: "Sodium", unit: "mg", group: "micro", dp: 0 },
  { key: "potassium_mg", label: "Potassium", unit: "mg", group: "micro", dp: 0 },
  { key: "calcium_mg", label: "Calcium", unit: "mg", group: "micro", dp: 0 },
  { key: "magnesium_mg", label: "Magnesium", unit: "mg", group: "micro", dp: 0 },
  { key: "iron_mg", label: "Iron", unit: "mg", group: "micro", dp: 1 },
  { key: "zinc_mg", label: "Zinc", unit: "mg", group: "micro", dp: 1 },
  { key: "selenium_ug", label: "Selenium", unit: "µg", group: "micro", dp: 0 },
  { key: "iodine_ug", label: "Iodine", unit: "µg", group: "micro", dp: 0 },
  { key: "cholesterol_mg", label: "Cholesterol", unit: "mg", group: "micro", dp: 0 },
  { key: "vitamin_a_ug", label: "Vitamin A", unit: "µg", group: "micro", dp: 0 },
  { key: "vitamin_c_mg", label: "Vitamin C", unit: "mg", group: "micro", dp: 0 },
  { key: "vitamin_d_ug", label: "Vitamin D", unit: "µg", group: "micro", dp: 1 },
  { key: "vitamin_e_mg", label: "Vitamin E", unit: "mg", group: "micro", dp: 1 },
  { key: "vitamin_k_ug", label: "Vitamin K", unit: "µg", group: "micro", dp: 0 },
  { key: "vitamin_b6_mg", label: "Vitamin B6", unit: "mg", group: "micro", dp: 1 },
  { key: "vitamin_b12_ug", label: "Vitamin B12", unit: "µg", group: "micro", dp: 1 },
  { key: "folate_ug", label: "Folate", unit: "µg", group: "micro", dp: 0 },
];

export const NUTRIENT_KEYS: NutrientKey[] = NUTRIENT_DEFS.map((d) => d.key);

const DEF_BY_KEY = new Map(NUTRIENT_DEFS.map((d) => [d.key, d]));

export function nutrientDef(key: NutrientKey): NutrientDef {
  return DEF_BY_KEY.get(key)!;
}

/** Sum a list of sparse nutrient maps into one. */
export function sumNutrients(list: Nutrients[]): Nutrients {
  const out: Nutrients = {};
  for (const n of list) {
    for (const [k, v] of Object.entries(n) as [NutrientKey, number][]) {
      if (typeof v === "number" && isFinite(v)) {
        out[k] = (out[k] ?? 0) + v;
      }
    }
  }
  return out;
}

/** Multiply every amount by a factor (e.g. supplement dose multiplier). */
export function scaleNutrients(n: Nutrients, factor: number): Nutrients {
  const out: Nutrients = {};
  for (const [k, v] of Object.entries(n) as [NutrientKey, number][]) {
    if (typeof v === "number" && isFinite(v)) out[k] = v * factor;
  }
  return out;
}

/**
 * Coerce an untrusted object (e.g. model output or DB JSON) into a valid
 * Nutrients map: known keys only, finite non-negative numbers only.
 */
export function sanitizeNutrients(raw: unknown): Nutrients {
  const out: Nutrients = {};
  if (raw && typeof raw === "object") {
    for (const def of NUTRIENT_DEFS) {
      const v = (raw as Record<string, unknown>)[def.key];
      const num = typeof v === "string" ? parseFloat(v) : v;
      if (typeof num === "number" && isFinite(num) && num >= 0) {
        out[def.key] = num;
      }
    }
  }
  return out;
}

/** Format an amount for display, e.g. `formatAmount("sodium_mg", 1234)` → "1234 mg". */
export function formatAmount(key: NutrientKey, value: number): string {
  const def = nutrientDef(key);
  const rounded = value.toFixed(def.dp);
  // Trim trailing ".0"
  const clean = def.dp > 0 ? String(parseFloat(rounded)) : rounded;
  return `${clean} ${def.unit}`;
}

/** Net carbs (total carbs minus fiber, floored at 0), or null when carbs are unknown. */
export function netCarbs(n: Nutrients): number | null {
  const carbs = n.carbs_g;
  if (carbs == null) return null;
  return Math.max(0, carbs - (n.fiber_g ?? 0));
}

/** Omega-6 : omega-3 ratio, or null when omega-3 is zero/unknown. */
export function omegaRatio(n: Nutrients): number | null {
  const o3 = n.omega3_g ?? 0;
  const o6 = n.omega6_g ?? 0;
  if (o3 <= 0) return null;
  return o6 / o3;
}
