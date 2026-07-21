/**
 * Open Food Facts lookup — one tool (`search_packaged_food`) shared by the
 * diary agent and the data assistant.
 *
 * Free-text queries hit the OFF search API; an all-digits query is treated as
 * an EAN/UPC barcode. Label nutrition is mapped onto Tally's nutrient keys,
 * per 100 g and (when the serving size is known) per serving. Only the query
 * text ever leaves the device — no photos, no personal data.
 */
import { fetch } from "@tauri-apps/plugin-http";
import type { ToolDef } from "./openrouter";
import { NUTRIENT_DEFS, scaleNutrients } from "./nutrients";
import { parseOffBarcodeResponse, parseOffSearchResponse } from "./schemas";
import type { OffProduct } from "./schemas";
import type { NutrientKey, Nutrients } from "./types";

const BASE = "https://world.openfoodfacts.org";

/** OFF asks API clients to identify themselves. */
const APP_UA = "Tally/0.1.0 (https://github.com/madsbuch/tally)";

const REQUEST_TIMEOUT_MS = 15_000;
const PAGE_SIZE = 5;
const MAX_INGREDIENTS_CHARS = 300;

// ---------------------------------------------------------------------------
// Tool definition (append to an agent's tool list)
// ---------------------------------------------------------------------------

export const FOOD_FACTS_TOOL: ToolDef = {
  type: "function",
  function: {
    name: "search_packaged_food",
    description:
      "Look up a branded/packaged product in the Open Food Facts database: pass the product " +
      "name plus brand if known (e.g. 'Coca-Cola Zero'), or a bare EAN/UPC barcode number. " +
      "Returns label nutrition per 100 g (and per serving when known) for the closest matches. " +
      "Branded/packaged products only — never home-cooked or generic foods.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Product name (add the brand for precision), or a digits-only barcode.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
};

// ---------------------------------------------------------------------------
// Nutriment mapping
// ---------------------------------------------------------------------------

/**
 * OFF nutriment id per Tally key. `*_100g` values are normalized to grams
 * (energy to kcal/kJ), so the tally unit alone determines the scale factor.
 */
const OFF_IDS: Record<NutrientKey, string> = {
  calories: "energy-kcal",
  protein_g: "proteins",
  carbs_g: "carbohydrates",
  fat_g: "fat",
  saturated_fat_g: "saturated-fat",
  fiber_g: "fiber",
  sugar_g: "sugars",
  omega3_g: "omega-3-fat",
  omega6_g: "omega-6-fat",
  sodium_mg: "sodium",
  potassium_mg: "potassium",
  calcium_mg: "calcium",
  magnesium_mg: "magnesium",
  iron_mg: "iron",
  zinc_mg: "zinc",
  selenium_ug: "selenium",
  iodine_ug: "iodine",
  cholesterol_mg: "cholesterol",
  vitamin_a_ug: "vitamin-a",
  vitamin_c_mg: "vitamin-c",
  vitamin_d_ug: "vitamin-d",
  vitamin_e_mg: "vitamin-e",
  vitamin_k_ug: "vitamin-k",
  vitamin_b6_mg: "vitamin-b6",
  vitamin_b12_ug: "vitamin-b12",
  folate_ug: "folates",
};

const KJ_PER_KCAL = 4.184;

function num(v: unknown): number | null {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return typeof n === "number" && isFinite(n) ? n : null;
}

function unitFactor(unit: string): number {
  if (unit === "mg") return 1000;
  if (unit === "µg") return 1_000_000;
  return 1; // g and kcal are OFF's native units
}

/** Map an OFF `nutriments` object to Tally keys, per 100 g. */
export function mapOffNutriments(raw: unknown): Nutrients {
  const out: Nutrients = {};
  if (!raw || typeof raw !== "object") return out;
  const n = raw as Record<string, unknown>;
  for (const def of NUTRIENT_DEFS) {
    let v = num(n[`${OFF_IDS[def.key]}_100g`]);
    // Fallbacks: kJ-only energy entries, folate under its vitamin-B9 id.
    if (v == null && def.key === "calories") {
      const kj = num(n["energy_100g"]);
      if (kj != null) v = kj / KJ_PER_KCAL;
    }
    if (v == null && def.key === "folate_ug") {
      v = num(n["vitamin-b9_100g"]);
    }
    if (v != null && v >= 0) out[def.key] = v * unitFactor(def.unit);
  }
  return out;
}

function roundNutrients(n: Nutrients): Nutrients {
  const out: Nutrients = {};
  for (const def of NUTRIENT_DEFS) {
    const v = n[def.key];
    if (v == null) continue;
    const f = 10 ** def.dp;
    out[def.key] = Math.round(v * f) / f;
  }
  return out;
}

// ---------------------------------------------------------------------------
// API access
// ---------------------------------------------------------------------------

const FIELDS = [
  "code",
  "product_name",
  "brands",
  "quantity",
  "serving_size",
  "serving_quantity",
  "nutriments",
  "nutriscore_grade",
  "ingredients_text",
].join(",");

async function offFetch(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { "User-Agent": APP_UA },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Open Food Facts request failed (HTTP ${res.status})`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function searchByName(query: string): Promise<OffProduct[]> {
  const url =
    `${BASE}/cgi/search.pl?action=process&json=1&search_simple=1` +
    `&page_size=${PAGE_SIZE}&fields=${FIELDS}&search_terms=${encodeURIComponent(query)}`;
  return parseOffSearchResponse(await offFetch(url));
}

async function fetchByBarcode(code: string): Promise<OffProduct[]> {
  const url = `${BASE}/api/v2/product/${code}?fields=${FIELDS}`;
  try {
    return parseOffBarcodeResponse(await offFetch(url));
  } catch {
    // OFF answers 404 for unknown barcodes — that's "no match", not a failure.
    return [];
  }
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function shapeProduct(p: OffProduct): Record<string, unknown> | null {
  const name = str(p.product_name);
  const per100 = roundNutrients(mapOffNutriments(p.nutriments));
  if (!name || Object.keys(per100).length === 0) return null;

  const out: Record<string, unknown> = { name, nutrients_per_100g: per100 };
  const barcode = str(p.code);
  if (barcode) out["barcode"] = barcode;
  const brand = str(p.brands);
  if (brand) out["brand"] = brand;
  const quantity = str(p.quantity);
  if (quantity) out["package_quantity"] = quantity;

  const servingG = num(p.serving_quantity);
  if (servingG != null && servingG > 0) {
    out["serving_size"] = str(p["serving_size"]) ?? `${servingG} g`;
    out["nutrients_per_serving"] = roundNutrients(scaleNutrients(per100, servingG / 100));
  }

  const grade = str(p.nutriscore_grade);
  if (grade && /^[a-e]$/i.test(grade)) out["nutriscore"] = grade.toUpperCase();
  const ingredients = str(p.ingredients_text);
  if (ingredients) {
    out["ingredients"] =
      ingredients.length > MAX_INGREDIENTS_CHARS
        ? `${ingredients.slice(0, MAX_INGREDIENTS_CHARS)}…`
        : ingredients;
  }
  return out;
}

/** Execute a `search_packaged_food` call; the result string goes to the model. */
export async function executeFoodFactsSearch(args: Record<string, unknown>): Promise<string> {
  const query = str(args["query"]);
  if (!query) throw new Error("query is required");
  const raw = /^\d{8,14}$/.test(query)
    ? await fetchByBarcode(query)
    : await searchByName(query);
  const products = raw
    .map(shapeProduct)
    .filter((p): p is Record<string, unknown> => p != null);
  if (products.length === 0) {
    return JSON.stringify({
      products: [],
      note: "No match with usable nutrition data — estimate the nutrients yourself.",
    });
  }
  return JSON.stringify({ products });
}
