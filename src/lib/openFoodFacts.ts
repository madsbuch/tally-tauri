/**
 * Open Food Facts lookup — one tool (`search_packaged_food`) shared by the
 * diary agent and the data assistant, and the label arithmetic behind
 * log_meal's `label` argument.
 *
 * Free-text queries go to OFF's search service (search.openfoodfacts.org),
 * first among products sold in the user's country, then worldwide; an
 * all-digits query is treated as an EAN/UPC barcode. Either way the nutrition
 * comes from the product endpoint, the part of OFF that stays up. The old
 * full-text search (cgi/search.pl) is allowed ten requests a minute and
 * answers 503 under load — that is what made the tool "not work" — so it is
 * only the fallback, and rationed.
 *
 * Label nutrition is mapped onto Tally's nutrient keys, per 100 g and (when
 * the serving size is known) per serving. Only the query text ever leaves the
 * device — no photos, no personal data.
 */
import { fetch } from "@tauri-apps/plugin-http";
import type { ToolDef } from "./openrouter";
import { getSetting } from "./db";
import { NUTRIENT_DEFS, scaleNutrients } from "./nutrients";
import {
  parseJson,
  parseOffBarcodeResponse,
  parseOffSearchHits,
  parseOffSearchResponse,
} from "./schemas";
import type { LabelArgs, OffProduct } from "./schemas";
import { SETTING_KEYS } from "./types";
import type { NutrientKey, Nutrients } from "./types";

const BASE = "https://world.openfoodfacts.org";
const SEARCH_BASE = "https://search.openfoodfacts.org";

/** OFF asks API clients to identify themselves. */
const APP_UA = "Tally/0.1.0 (https://github.com/madsbuch/tally)";

const REQUEST_TIMEOUT_MS = 10_000;
/** search.pl is slow even when it works. */
const LEGACY_SEARCH_TIMEOUT_MS = 20_000;
const RETRY_DELAY_MS = 1_500;
const PAGE_SIZE = 4;
const MAX_INGREDIENTS_CHARS = 300;
/** More than this in one sitting is a misread amount, not a meal. */
const MAX_PORTION_G = 5_000;

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
      "Searches products sold in the user's country first, then worldwide. Returns label " +
      "nutrition per 100 g (per 100 ml for drinks), and per serving when known, for the " +
      "closest matches. Branded/packaged products only — never home-cooked or generic foods.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Product name as printed on the package, in its language (add the brand for " +
            "precision), or a digits-only barcode.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
};

// ---------------------------------------------------------------------------
// Country & language
// ---------------------------------------------------------------------------

/** The `food_country` value meaning "no country, search worldwide". */
export const WORLDWIDE = "world";

export interface FoodRegion {
  /** ISO 3166-1 alpha-2, lowercase; null = worldwide. */
  cc: string | null;
  /** Languages product names are searched and shown in, most wanted first. */
  langs: string[];
}

function deviceLocales(): string[] {
  return navigator.languages.length > 0 ? [...navigator.languages] : [navigator.language];
}

function localeOf(tag: string): Intl.Locale | null {
  try {
    return new Intl.Locale(tag);
  } catch {
    return null;
  }
}

/**
 * The country the phone's locale names: "da-DK" → "dk". A bare language
 * stands for its usual country ("da" → "dk"); numeric regions ("es-419")
 * aren't countries.
 */
export function deviceCountry(): string | null {
  const locales = deviceLocales();
  for (const tag of locales) {
    const region = localeOf(tag)?.region;
    if (region && /^[A-Z]{2}$/.test(region)) return region.toLowerCase();
  }
  const guessed = localeOf(locales[0] ?? "")?.maximize().region;
  return guessed && /^[A-Z]{2}$/.test(guessed) ? guessed.toLowerCase() : null;
}

/** The main language of a country: "dk" → "da", "ch" → "de". */
function countryLanguage(cc: string): string | null {
  return localeOf(`und-${cc.toUpperCase()}`)?.maximize().language ?? null;
}

/** "dk" → "Denmark"; null for codes the platform doesn't know. */
export function countryName(cc: string): string | null {
  try {
    const name = new Intl.DisplayNames(["en"], { type: "region" }).of(cc.toUpperCase());
    // Unknown codes come back as the code itself.
    return name && name.toUpperCase() !== cc.toUpperCase() ? name : null;
  } catch {
    return null;
  }
}

/** Where OFF's country taxonomy names a country differently than the platform does. */
const COUNTRY_TAG_OVERRIDES: Record<string, string> = {
  cz: "czech-republic",
  hk: "hong-kong",
  tr: "turkey",
};

/** OFF's countries_tags value for a country: "dk" → "en:denmark". */
function countryTag(cc: string): string | null {
  const name = COUNTRY_TAG_OVERRIDES[cc] ?? countryName(cc);
  if (!name) return null;
  const slug = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return slug ? `en:${slug}` : null;
}

/**
 * The country searches favour: the one picked in Settings, else the phone's.
 * Languages: the phone's, the country's own (that's what's on its packages),
 * and English, which most OFF entries have.
 */
export async function foodRegion(): Promise<FoodRegion> {
  const saved = (await getSetting(SETTING_KEYS.foodCountry).catch(() => null))
    ?.trim()
    .toLowerCase();
  const cc =
    saved === WORLDWIDE ? null : saved && /^[a-z]{2}$/.test(saved) ? saved : deviceCountry();
  const langs: string[] = [];
  for (const lang of [
    localeOf(deviceLocales()[0] ?? "")?.language,
    cc ? countryLanguage(cc) : null,
    "en",
  ]) {
    if (lang && /^[a-z]{2,3}$/.test(lang) && !langs.includes(lang)) langs.push(lang);
  }
  return { cc, langs };
}

/** "Denmark", or "worldwide" — for prompts and Settings. */
export function regionLabel(region: FoodRegion): string {
  return region.cc ? (countryName(region.cc) ?? region.cc.toUpperCase()) : "worldwide";
}

// ---------------------------------------------------------------------------
// Nutriment mapping
// ---------------------------------------------------------------------------

/**
 * OFF nutriment id per Tally key. `*_100g` values are normalized to grams
 * (energy to kcal/kJ), so the tally unit alone determines the scale factor.
 * null = no corresponding OFF field; the key is never filled from labels.
 */
const OFF_IDS: Record<NutrientKey, string | null> = {
  calories: "energy-kcal",
  protein_g: "proteins",
  carbs_g: "carbohydrates",
  fat_g: "fat",
  saturated_fat_g: "saturated-fat",
  trans_fat_g: "trans-fat",
  fiber_g: "fiber",
  sugar_g: "sugars",
  omega3_g: "omega-3-fat",
  omega6_g: "omega-6-fat",
  sodium_mg: "sodium",
  potassium_mg: "potassium",
  calcium_mg: "calcium",
  magnesium_mg: "magnesium",
  phosphorus_mg: "phosphorus",
  iron_mg: "iron",
  zinc_mg: "zinc",
  copper_mg: "copper",
  manganese_mg: "manganese",
  selenium_ug: "selenium",
  iodine_ug: "iodine",
  cholesterol_mg: "cholesterol",
  vitamin_a_ug: "vitamin-a",
  vitamin_c_mg: "vitamin-c",
  vitamin_d_ug: "vitamin-d",
  vitamin_e_mg: "vitamin-e",
  vitamin_k_ug: "vitamin-k",
  thiamin_mg: "vitamin-b1",
  riboflavin_mg: "vitamin-b2",
  niacin_mg: "vitamin-pp",
  pantothenic_acid_mg: "pantothenic-acid",
  vitamin_b6_mg: "vitamin-b6",
  biotin_ug: "biotin",
  vitamin_b12_ug: "vitamin-b12",
  folate_ug: "folates",
  choline_mg: "choline",
  creatine_g: null,
  caffeine_mg: "caffeine",
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
    const offId = OFF_IDS[def.key];
    let v = offId != null ? num(n[`${offId}_100g`]) : null;
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

const BASE_FIELDS = [
  "code",
  "product_name",
  "brands",
  "quantity",
  "product_quantity",
  "product_quantity_unit",
  "serving_size",
  "serving_quantity",
  "nutriments",
  "nutriscore_grade",
  "ingredients_text",
  "countries_tags",
];

/** The base fields plus the product name in each wanted language. */
function fieldsFor(region: FoodRegion): string {
  return [...BASE_FIELDS, ...region.langs.map((l) => `product_name_${l}`)].join(",");
}

class OffHttpError extends Error {
  constructor(readonly status: number) {
    super(`Open Food Facts answered HTTP ${status}`);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function offGetOnce(url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { "User-Agent": APP_UA, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) throw new OffHttpError(res.status);
    const text = await res.text();
    try {
      return parseJson(text);
    } catch {
      // Overloaded, OFF serves its "temporarily unavailable" web page.
      throw new Error("Open Food Facts sent a web page instead of data (it's overloaded)");
    }
  } catch (e) {
    if (controller.signal.aborted) {
      throw new Error(`Open Food Facts didn't answer within ${timeoutMs / 1000} s`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GET + parse, retried once after a pause when the failure is the passing
 * kind (5xx, 429, a timeout, an error page) — OFF's 503s mostly clear on the
 * next attempt. A 404 is an answer, not a failure.
 */
async function offGet(url: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
  try {
    return await offGetOnce(url, timeoutMs);
  } catch (e) {
    if (e instanceof OffHttpError && e.status !== 429 && e.status < 500) throw e;
    await sleep(RETRY_DELAY_MS);
    return offGetOnce(url, timeoutMs);
  }
}

/**
 * Products seen this session, by barcode: a search followed by log_meal
 * fetches the product once, and "another one of those" not at all.
 */
const productCache = new Map<string, OffProduct>();
const PRODUCT_CACHE_MAX = 200;

function remember(code: string, p: OffProduct): void {
  productCache.delete(code);
  productCache.set(code, p);
  if (productCache.size > PRODUCT_CACHE_MAX) {
    const oldest = productCache.keys().next().value;
    if (oldest !== undefined) productCache.delete(oldest);
  }
}

/** One product by barcode; null when OFF doesn't have it. */
async function productByBarcode(code: string, region: FoodRegion): Promise<OffProduct | null> {
  const cached = productCache.get(code);
  if (cached) return cached;
  const params = new URLSearchParams({ fields: fieldsFor(region) });
  const lc = region.langs[0];
  if (lc) params.set("lc", lc);
  let raw: unknown;
  try {
    raw = await offGet(`${BASE}/api/v2/product/${encodeURIComponent(code)}?${params}`);
  } catch (e) {
    if (e instanceof OffHttpError && e.status === 404) return null;
    throw e;
  }
  const product = parseOffBarcodeResponse(raw)[0] ?? null;
  if (product) remember(code, product);
  return product;
}

/** Lucene syntax characters would turn "Brand: X" or "Coca-Cola" into operators. */
function plainWords(query: string): string {
  return query.replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, " ").replace(/\s+/g, " ").trim();
}

/** Barcodes of the best hits from the search service; [] = no match. */
async function searchCodes(words: string, region: FoodRegion, tag: string | null): Promise<string[]> {
  const params = new URLSearchParams({
    // A quoted field clause filters; the bare words are the full-text search.
    q: tag ? `${words} countries_tags:"${tag}"` : words,
    langs: region.langs.join(","),
    page_size: String(PAGE_SIZE),
    fields: "code",
  });
  const codes = parseOffSearchHits(await offGet(`${SEARCH_BASE}/search?${params}`));
  if (codes == null) throw new Error("Open Food Facts search sent something that isn't a result");
  return codes;
}

/**
 * search.pl's budget is ten requests a minute per user; going over gets the
 * device's IP blocked. Stay under it rather than find out.
 */
const LEGACY_SEARCHES_PER_MINUTE = 8;
const legacySearchTimes: number[] = [];

function takeLegacySearchSlot(): boolean {
  const now = Date.now();
  while ((legacySearchTimes[0] ?? now) <= now - 60_000) legacySearchTimes.shift();
  if (legacySearchTimes.length >= LEGACY_SEARCHES_PER_MINUTE) return false;
  legacySearchTimes.push(now);
  return true;
}

/** The old full-text search, scoped to a country (`cc`) or the world. */
async function legacySearch(words: string, region: FoodRegion, cc: string): Promise<OffProduct[]> {
  if (!takeLegacySearchSlot()) {
    throw new Error("Open Food Facts search is rate-limited — wait a minute");
  }
  const params = new URLSearchParams({
    action: "process",
    json: "1",
    search_simple: "1",
    page_size: String(PAGE_SIZE),
    fields: fieldsFor(region),
    search_terms: words,
    cc,
  });
  const lc = region.langs[0];
  if (lc) params.set("lc", lc);
  const products = parseOffSearchResponse(
    await offGetOnce(`${BASE}/cgi/search.pl?${params}`, LEGACY_SEARCH_TIMEOUT_MS),
  );
  for (const p of products) {
    const code = str(p.code);
    if (code) remember(code, p);
  }
  return products;
}

interface SearchResult {
  products: OffProduct[];
  /** Where the products came from: a country name or "worldwide". */
  scope: string;
}

/**
 * Name search, narrowest first: the user's country, then the world. The
 * search service only finds barcodes; the products themselves come from the
 * product endpoint. When the search service fails or finds nothing, the old
 * search gets the same two tries.
 */
async function searchByName(query: string, region: FoodRegion): Promise<SearchResult> {
  const words = plainWords(query);
  if (!words) return { products: [], scope: regionLabel(region) };
  const tag = region.cc ? countryTag(region.cc) : null;
  const scopes: { tag: string | null; cc: string; label: string }[] = [
    ...(region.cc ? [{ tag, cc: region.cc, label: regionLabel(region) }] : []),
    { tag: null, cc: WORLDWIDE, label: "worldwide" },
  ];

  let failure: unknown = null;
  try {
    for (const scope of scopes) {
      // A country the taxonomy can't name can't be filtered on.
      if (scope.cc !== WORLDWIDE && !scope.tag) continue;
      const codes = await searchCodes(words, region, scope.tag);
      if (codes.length === 0) continue;
      const products = await productsByBarcode(codes, region);
      if (products.length > 0) return { products, scope: scope.label };
    }
  } catch (e) {
    failure = e;
  }

  try {
    for (const scope of scopes) {
      const products = await legacySearch(words, region, scope.cc);
      if (products.length > 0) return { products, scope: scope.label };
    }
  } catch (e) {
    // The search service answered and found nothing: that's the answer.
    if (failure == null) return { products: [], scope: "worldwide" };
    throw new Error(`${errorText(failure)}; the fallback search failed too: ${errorText(e)}`);
  }
  return { products: [], scope: "worldwide" };
}

/** Several products at once; one that fails to load is skipped, not fatal. */
async function productsByBarcode(codes: string[], region: FoodRegion): Promise<OffProduct[]> {
  const settled = await Promise.allSettled(codes.map((c) => productByBarcode(c, region)));
  const products: OffProduct[] = [];
  for (const s of settled) {
    if (s.status === "fulfilled" && s.value) products.push(s.value);
  }
  const failed = settled.find((s) => s.status === "rejected");
  if (products.length === 0 && failed) throw failed.reason;
  return products;
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** The product's name in the first wanted language it has, else its main one. */
function productName(p: OffProduct, region: FoodRegion): string | null {
  for (const lang of region.langs) {
    const name = str(p[`product_name_${lang}`]);
    if (name) return name;
  }
  return str(p.product_name);
}

/** "ml" when OFF measures this product by volume — its "100 g" is then 100 ml. */
function unitOf(p: OffProduct): "g" | "ml" {
  return str(p.product_quantity_unit)?.toLowerCase() === "ml" ? "ml" : "g";
}

function soldIn(p: OffProduct, cc: string): boolean | null {
  const tag = countryTag(cc);
  if (!tag || !Array.isArray(p.countries_tags)) return null;
  return p.countries_tags.includes(tag);
}

function shapeProduct(p: OffProduct, region: FoodRegion): Record<string, unknown> | null {
  const name = productName(p, region);
  const per100 = roundNutrients(mapOffNutriments(p.nutriments));
  if (!name || Object.keys(per100).length === 0) return null;

  const unit = unitOf(p);
  const out: Record<string, unknown> = { name };
  const barcode = str(p.code);
  if (barcode) out["barcode"] = barcode;
  const brand = str(p.brands);
  if (brand) out["brand"] = brand;
  if (region.cc) {
    const local = soldIn(p, region.cc);
    if (local != null) out["sold_in_users_country"] = local;
  }
  const quantity = str(p.quantity);
  if (quantity) out["package_quantity"] = quantity;
  out[unit === "ml" ? "nutrients_per_100ml" : "nutrients_per_100g"] = per100;

  const serving = num(p.serving_quantity);
  if (serving != null && serving > 0) {
    out["serving_size"] = str(p.serving_size) ?? `${serving} ${unit}`;
    out["nutrients_per_serving"] = roundNutrients(scaleNutrients(per100, serving / 100));
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

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Execute a `search_packaged_food` call; the result string goes to the model. */
export async function executeFoodFactsSearch(args: Record<string, unknown>): Promise<string> {
  const query = str(args["query"]);
  if (!query) throw new Error("query is required");
  const region = await foodRegion();

  let result: SearchResult;
  try {
    if (/^\d{8,14}$/.test(query)) {
      const product = await productByBarcode(query, region);
      result = { products: product ? [product] : [], scope: "barcode" };
    } else {
      result = await searchByName(query, region);
    }
  } catch (e) {
    return JSON.stringify({
      products: [],
      error: `Open Food Facts couldn't be reached: ${errorText(e)}.`,
      note: "Estimate the nutrients yourself.",
    });
  }

  const products = result.products
    .map((p) => shapeProduct(p, region))
    .filter((p): p is Record<string, unknown> => p != null);
  if (products.length === 0) {
    return JSON.stringify({
      products: [],
      note: "No match with usable nutrition data — estimate the nutrients yourself.",
    });
  }
  return JSON.stringify({ searched: result.scope, products });
}

// ---------------------------------------------------------------------------
// Label arithmetic (log_meal's `label` argument)
// ---------------------------------------------------------------------------

export interface LabelPortion {
  /** Label nutrients for the amount eaten, rounded like the tool shows them. */
  nutrients: Nutrients;
  /** Amount eaten, in `unit`. */
  amount: number;
  unit: "g" | "ml";
  /** "Coca-Cola Zero (Coca-Cola)" */
  product: string;
  barcode: string;
}

/**
 * The label's numbers for what was actually eaten, worked out here rather
 * than by the model: per-100 g values times grams is arithmetic, and the one
 * thing a model shouldn't be trusted to get right every time. Throws with a
 * message meant for the model when the label can't answer.
 */
export async function labelPortion(label: LabelArgs): Promise<LabelPortion> {
  const region = await foodRegion();
  const p = await productByBarcode(label.barcode, region);
  if (!p) {
    throw new Error(
      `Open Food Facts has no product ${label.barcode}. Use a barcode from search_packaged_food, or log it without label.`,
    );
  }
  const per100 = mapOffNutriments(p.nutriments);
  if (per100.calories == null) {
    throw new Error("That label has no energy value. Log it without label and estimate it.");
  }

  const unit = unitOf(p);
  let amount: number;
  if (label.grams != null) {
    amount = label.grams;
  } else if (label.servings != null) {
    const serving = num(p.serving_quantity);
    if (serving == null || serving <= 0) {
      throw new Error("That label gives no serving size. Pass grams instead.");
    }
    amount = label.servings * serving;
  } else if (label.packages != null) {
    const pack = num(p.product_quantity);
    if (pack == null || pack <= 0) {
      throw new Error("That label gives no package size. Pass grams instead.");
    }
    amount = label.packages * pack;
  } else {
    throw new Error("label needs how much was eaten: grams, servings or packages.");
  }
  if (amount > MAX_PORTION_G) {
    throw new Error(`${Math.round(amount)} ${unit} is more than one sitting. Check the amount.`);
  }

  const name = productName(p, region) ?? "the product";
  const brand = str(p.brands);
  return {
    nutrients: roundNutrients(scaleNutrients(per100, amount / 100)),
    amount: Math.round(amount * 10) / 10,
    unit,
    product: brand && !name.toLowerCase().includes(brand.toLowerCase()) ? `${name} (${brand})` : name,
    barcode: label.barcode,
  };
}
