import type { NutrientKey, Nutrients } from "./types";

export interface NutrientDef {
  key: NutrientKey;
  label: string;
  unit: string;
  /** "other" = compounds without a classic macro/micro role (creatine, caffeine). */
  group: "macro" | "micro" | "other";
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
  { key: "trans_fat_g", label: "Trans fat", unit: "g", group: "macro", dp: 1 },
  { key: "fiber_g", label: "Fiber", unit: "g", group: "macro", dp: 1 },
  { key: "sugar_g", label: "Sugar", unit: "g", group: "macro", dp: 1 },
  { key: "omega3_g", label: "Omega-3", unit: "g", group: "macro", dp: 2 },
  { key: "omega6_g", label: "Omega-6", unit: "g", group: "macro", dp: 2 },
  { key: "sodium_mg", label: "Sodium", unit: "mg", group: "micro", dp: 0 },
  { key: "potassium_mg", label: "Potassium", unit: "mg", group: "micro", dp: 0 },
  { key: "calcium_mg", label: "Calcium", unit: "mg", group: "micro", dp: 0 },
  { key: "magnesium_mg", label: "Magnesium", unit: "mg", group: "micro", dp: 0 },
  { key: "phosphorus_mg", label: "Phosphorus", unit: "mg", group: "micro", dp: 0 },
  { key: "iron_mg", label: "Iron", unit: "mg", group: "micro", dp: 1 },
  { key: "zinc_mg", label: "Zinc", unit: "mg", group: "micro", dp: 1 },
  { key: "copper_mg", label: "Copper", unit: "mg", group: "micro", dp: 1 },
  { key: "manganese_mg", label: "Manganese", unit: "mg", group: "micro", dp: 1 },
  { key: "selenium_ug", label: "Selenium", unit: "µg", group: "micro", dp: 0 },
  { key: "iodine_ug", label: "Iodine", unit: "µg", group: "micro", dp: 0 },
  { key: "cholesterol_mg", label: "Cholesterol", unit: "mg", group: "micro", dp: 0 },
  { key: "vitamin_a_ug", label: "Vitamin A", unit: "µg", group: "micro", dp: 0 },
  { key: "vitamin_c_mg", label: "Vitamin C", unit: "mg", group: "micro", dp: 0 },
  { key: "vitamin_d_ug", label: "Vitamin D", unit: "µg", group: "micro", dp: 1 },
  { key: "vitamin_e_mg", label: "Vitamin E", unit: "mg", group: "micro", dp: 1 },
  { key: "vitamin_k_ug", label: "Vitamin K", unit: "µg", group: "micro", dp: 0 },
  { key: "thiamin_mg", label: "Thiamin (B1)", unit: "mg", group: "micro", dp: 1 },
  { key: "riboflavin_mg", label: "Riboflavin (B2)", unit: "mg", group: "micro", dp: 1 },
  { key: "niacin_mg", label: "Niacin (B3)", unit: "mg", group: "micro", dp: 1 },
  { key: "pantothenic_acid_mg", label: "Pantothenic acid (B5)", unit: "mg", group: "micro", dp: 1 },
  { key: "vitamin_b6_mg", label: "Vitamin B6", unit: "mg", group: "micro", dp: 1 },
  { key: "biotin_ug", label: "Biotin (B7)", unit: "µg", group: "micro", dp: 0 },
  { key: "vitamin_b12_ug", label: "Vitamin B12", unit: "µg", group: "micro", dp: 1 },
  { key: "folate_ug", label: "Folate", unit: "µg", group: "micro", dp: 0 },
  { key: "choline_mg", label: "Choline", unit: "mg", group: "micro", dp: 0 },
  { key: "creatine_g", label: "Creatine", unit: "g", group: "other", dp: 1 },
  { key: "caffeine_mg", label: "Caffeine", unit: "mg", group: "other", dp: 0 },
];

export const NUTRIENT_KEYS: NutrientKey[] = NUTRIENT_DEFS.map((d) => d.key);

/**
 * Approximate adult daily reference intakes. Shared by the Nutrients page
 * and the achievements engine (which only counts group "micro" keys —
 * creatine's target is a supplementation goal, not an RDA).
 * cholesterol_mg and caffeine_mg intentionally have no reference — value only.
 */
export const REFERENCE_INTAKES: Partial<Record<NutrientKey, number>> = {
  sodium_mg: 2300,
  potassium_mg: 3400,
  calcium_mg: 1000,
  magnesium_mg: 400,
  phosphorus_mg: 700,
  iron_mg: 8,
  zinc_mg: 11,
  copper_mg: 0.9,
  manganese_mg: 2.3,
  selenium_ug: 55,
  iodine_ug: 150,
  vitamin_a_ug: 900,
  vitamin_c_mg: 90,
  vitamin_d_ug: 20,
  vitamin_e_mg: 15,
  vitamin_k_ug: 120,
  thiamin_mg: 1.2,
  riboflavin_mg: 1.3,
  niacin_mg: 16,
  pantothenic_acid_mg: 5,
  vitamin_b6_mg: 1.7,
  biotin_ug: 30,
  vitamin_b12_ug: 2.4,
  folate_ug: 400,
  choline_mg: 550,
  creatine_g: 5,
};

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
