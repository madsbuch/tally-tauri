/**
 * The single home for parsing untrusted JSON: database columns, LLM output,
 * external APIs, and settings blobs. Every boundary gets a zod schema plus a
 * small parse helper so call sites never touch raw `unknown` or cast with
 * `as`. ESLint bans `JSON.parse` outside this file (see eslint.config.js and
 * CLAUDE.md).
 *
 * Schemas for model/API output are deliberately forgiving: they coerce and
 * default rather than reject, because a sloppy-but-usable answer beats a
 * failed analysis. Schemas for our own persisted data (chat transcripts)
 * are strict — invalid rows signal corruption and surface as `null`.
 */
import { z } from "zod";
import { sanitizeNutrients } from "./nutrients";
import type { FoodEntry, Workout } from "./types";

/** The one sanctioned `JSON.parse` — always feed the result to a schema. */
export function parseJson(text: string): unknown {
  // eslint-disable-next-line no-restricted-properties -- the single allowed call
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// Chat transcripts (OpenAI-style messages; persisted in the `chats` table)
// ---------------------------------------------------------------------------

export const ToolCallSchema = z.object({
  id: z.string(),
  type: z.literal("function"),
  function: z.object({ name: z.string(), arguments: z.string() }),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

export const ContentPartSchema = z.union([
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("image_url"), image_url: z.object({ url: z.string() }) }),
]);
export type ContentPart = z.infer<typeof ContentPartSchema>;

export const ChatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.union([z.string(), z.array(ContentPartSchema), z.null()]),
  tool_calls: z.array(ToolCallSchema).optional(),
  tool_call_id: z.string().optional(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

/** A saved `chats.messages` transcript; null = corrupt / unknown shape. */
export function parseChatTranscript(raw: unknown): ChatMessage[] | null {
  const r = z.array(ChatMessageSchema).safeParse(raw);
  return r.success ? r.data : null;
}

/**
 * Arguments of one tool call (a JSON object string; "" = no arguments).
 * Throws on malformed JSON or a non-object — callers report that to the model.
 */
export function parseToolArgs(argsJson: string): Record<string, unknown> {
  return z.record(z.string(), z.unknown()).parse(parseJson(argsJson || "{}"));
}

// ---------------------------------------------------------------------------
// OpenRouter /chat/completions response
// ---------------------------------------------------------------------------

const ChatErrorSchema = z.object({
  message: z.string().optional(),
  code: z.union([z.number(), z.string()]).optional(),
});

// `.catch(undefined)` per field: one malformed part of a provider response
// must not invalidate the rest of it.
const ChatChoiceSchema = z.object({
  message: z
    .object({
      content: z.unknown().optional(),
      tool_calls: z.array(ToolCallSchema).optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
  finish_reason: z.string().optional().catch(undefined),
  error: ChatErrorSchema.optional().catch(undefined),
});

export const ChatResponseSchema = z.object({
  choices: z.array(ChatChoiceSchema).optional().catch(undefined),
  error: ChatErrorSchema.optional().catch(undefined),
});
export type ChatResponse = z.infer<typeof ChatResponseSchema>;

/** Never throws — an unrecognizable body parses as `{}` (treated as an error upstream). */
export function parseChatResponse(raw: unknown): ChatResponse {
  const r = ChatResponseSchema.safeParse(raw);
  return r.success ? r.data : {};
}

// ---------------------------------------------------------------------------
// OpenRouter model listing (live /models response and the settings cache)
// ---------------------------------------------------------------------------

export const ORModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional().catch(undefined),
  context_length: z.number().optional().catch(undefined),
  created: z.number().optional().catch(undefined),
  pricing: z
    .object({
      prompt: z.string().optional(),
      completion: z.string().optional(),
      image: z.string().optional(),
      request: z.string().optional(),
    })
    .optional()
    .catch(undefined),
  architecture: z
    .object({
      input_modalities: z.array(z.string()).optional(),
      output_modalities: z.array(z.string()).optional(),
      tokenizer: z.string().optional(),
    })
    .optional()
    .catch(undefined),
  supported_parameters: z.array(z.string()).optional().catch(undefined),
});
export type ORModel = z.infer<typeof ORModelSchema>;

/** A model array (settings cache): keeps valid entries, drops the rest; null = not an array. */
export function parseModelList(raw: unknown): ORModel[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.flatMap((m) => {
    const r = ORModelSchema.safeParse(m);
    return r.success ? [r.data] : [];
  });
}

/** The live /models response envelope; null on an unexpected shape. */
export function parseModelsResponse(raw: unknown): ORModel[] | null {
  const r = z.object({ data: z.unknown() }).safeParse(raw);
  return r.success ? parseModelList(r.data.data) : null;
}

// ---------------------------------------------------------------------------
// LLM analysis output (nutrition / workout estimators)
// ---------------------------------------------------------------------------

const ConfidenceSchema = z.enum(["low", "medium", "high"]).catch("low");

/** Non-empty trimmed string, else the fallback. */
const looseTitle = (fallback: string) =>
  z.unknown().optional().transform((v) => (typeof v === "string" && v.trim() ? v.trim() : fallback));

const looseDescription = z
  .unknown()
  .optional()
  .transform((v) => (typeof v === "string" ? v.trim() : ""));

/** Finite non-negative number (numeric strings coerced), rounded; else 0. */
const looseKcal = z.unknown().optional().transform((v) => {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return typeof n === "number" && isFinite(n) && n >= 0 ? Math.round(n) : 0;
});

/** Positive minutes (numeric strings coerced), rounded; else null. */
const looseMinutes = z.unknown().optional().transform((v) => {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return typeof n === "number" && isFinite(n) && n > 0 ? Math.round(n) : null;
});

/** Known nutrient keys only, finite non-negative amounts only. */
const NutrientsField = z.unknown().optional().transform((v) => sanitizeNutrients(v));

export const FoodAnalysisSchema = z.object({
  title: looseTitle("Meal"),
  description: looseDescription,
  confidence: ConfidenceSchema,
  nutrients: NutrientsField,
});

export const WorkoutAnalysisSchema = z.object({
  title: looseTitle("Workout"),
  description: looseDescription,
  confidence: ConfidenceSchema,
  calories_burned: looseKcal,
  duration_min: looseMinutes,
});

/**
 * One turn of the conversation on an entry's page.
 *
 * `reply` is what gets said back and is always there. `entry` is the whole
 * corrected entry, present only when the message actually changed what was
 * eaten or done — "why is this so high?" is a question, and answering it must
 * not move a single number. The whole entry rather than a patch: a portion
 * change moves every nutrient with it, and asking for a patch invites half of
 * them to be left behind.
 */
/**
 * A field the model may simply not mention.
 *
 * Absent has to mean "unchanged", and that must survive parsing. The analysis
 * schemas above default a missing title to "Meal" and missing nutrients to {},
 * which is right when the model is describing a photo from nothing — but here
 * it would turn a correction the model chose to write as a patch into an entry
 * wipe: a renamed meal, a wiped set of nutrients, a workout burning 0 kcal. So
 * these parse to `undefined` when the key isn't there, and the caller keeps
 * what the entry already had.
 */
const keptText = z
  .unknown()
  .optional()
  .transform((v) => (typeof v === "string" && v.trim() ? v.trim() : undefined));

const keptNutrients = z
  .unknown()
  .optional()
  .transform((v) => (v !== null && typeof v === "object" ? sanitizeNutrients(v) : undefined));

const keptKcal = z.unknown().optional().transform((v) => {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return typeof n === "number" && isFinite(n) && n >= 0 ? Math.round(n) : undefined;
});

/** Absent leaves the duration alone; sent-but-empty says there isn't one. */
const keptMinutes = z.unknown().optional().transform((v) => {
  if (v === undefined) return undefined;
  const n = typeof v === "string" ? parseFloat(v) : v;
  return typeof n === "number" && isFinite(n) && n > 0 ? Math.round(n) : null;
});

const MealEntryFields = z.object({
  title: keptText,
  description: keptText,
  nutrients: keptNutrients,
});

const WorkoutEntryFields = z.object({
  title: keptText,
  description: keptText,
  calories_burned: keptKcal,
  duration_min: keptMinutes,
  zone2_min: z.unknown().optional().transform((v) => {
    if (v === undefined) return undefined;
    if (v === null || v === "") return null;
    const n = typeof v === "string" ? Number(v) : v;
    return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined;
  }),
});

/**
 * The corrected entry, or null for a turn that only talked.
 *
 * A model saying "nothing changed" often says it as `"entry": {}` — or as
 * `"entry": "no"` — and an entry carrying nothing recognisable is not a
 * revision. Saying so here beats letting an empty object travel on as one.
 */
function revisedEntry<T extends z.ZodObject>(fields: T) {
  const keys = Object.keys(fields.shape);
  return z
    .unknown()
    .optional()
    .transform((v) => {
      if (!v || typeof v !== "object" || Array.isArray(v)) return null;
      if (!keys.some((k) => k in v)) return null;
      const r = fields.safeParse(v);
      return r.success ? r.data : null;
    });
}

/**
 * Whether to keep the meal (as it stands after this turn) for reuse, and
 * under what name. Models say yes in several shapes — `true`, a bare name,
 * `{"name": …}` — and all of them mean the same; anything else is a no.
 * `{name: null}` means "save it under the entry's title".
 */
const saveRequest = z
  .unknown()
  .optional()
  .transform((v): { name: string | null } | null => {
    if (v === true) return { name: null };
    if (typeof v === "string") return v.trim() ? { name: v.trim() } : null;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const name = "name" in v ? v.name : undefined;
      return { name: typeof name === "string" && name.trim() ? name.trim() : null };
    }
    return null;
  });

export const MealChatSchema = z.object({
  reply: looseDescription,
  entry: revisedEntry(MealEntryFields),
  save: saveRequest,
});

export const WorkoutChatSchema = z.object({
  reply: looseDescription,
  entry: revisedEntry(WorkoutEntryFields),
});

// ---------------------------------------------------------------------------
// Per-entry threads (the `entry_messages` table)
// ---------------------------------------------------------------------------

/** The change lines stored with a message ("Calories: 48 kcal -> 112 kcal"). */
export function parseEntryChanges(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === "string" && v.length > 0);
}

/**
 * The entry a message rewrote, kept so undo outlives the visit.
 *
 * Strict, and deliberately so: this is our own row, written from a typed
 * entry, and a snapshot we cannot read back exactly is one we must not write
 * back over a good entry. Unreadable means the undo is gone — never that a
 * half-restored entry gets saved.
 */
const FoodEntrySnapshotSchema = z.object({
  id: z.number(),
  eaten_at: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  photo_path: z.string().nullable(),
  nutrients: z.unknown().transform((v) => sanitizeNutrients(v)),
  model_id: z.string().nullable(),
  icon: z.string().nullable(),
  day: z.string().nullable(),
  tz_offset_min: z.number().nullable(),
  // Snapshots written before the fast exemption existed have no note.
  fast_ok_note: z.string().nullable().default(null),
});

const WorkoutSnapshotSchema = z.object({
  id: z.number(),
  performed_at: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  photo_path: z.string().nullable(),
  calories_burned: z.number(),
  duration_min: z.number().nullable(),
  zone2_min: z.number().nonnegative().nullable().default(null),
  // Snapshots written before the cardio switch existed have no flag.
  cardio: z.boolean().default(false),
  model_id: z.string().nullable(),
  icon: z.string().nullable(),
  source: z.string().nullable(),
  external_id: z.string().nullable(),
  day: z.string().nullable(),
  tz_offset_min: z.number().nullable(),
});

/** A stored `before_entry` column; null when there is nothing to undo to. */
export function parseEntrySnapshot(raw: unknown): FoodEntry | Workout | null {
  if (raw == null) return null;
  const meal = FoodEntrySnapshotSchema.safeParse(raw);
  if (meal.success) return meal.data;
  const workout = WorkoutSnapshotSchema.safeParse(raw);
  return workout.success ? workout.data : null;
}

/**
 * One emoji for a state someone just invented ("Ears ringing" → 👂).
 *
 * Forgiving about what comes back — a model will happily answer "👂 (ear)" or
 * wrap it in quotes — but strict about what gets through: anything with ASCII
 * letters or digits in it is a word, not a glyph, and a word in the chip
 * where the icon goes looks like a bug. Nothing usable becomes null, and the
 * caller falls back to 💭.
 */
export const StateIconSchema = z.object({
  icon: z
    .unknown()
    .optional()
    .transform((v) => {
      if (typeof v !== "string") return null;
      // Keep the first "character" — an emoji can be several code points, and
      // a variation selector or a skin-tone modifier is part of the glyph.
      const first = [...v.trim()][0] ?? "";
      const glyph = v.trim().split(/\s/)[0] ?? "";
      const candidate = glyph.length <= 8 ? glyph : first;
      return candidate && !/[a-zA-Z0-9]/.test(candidate) ? candidate : null;
    }),
});

export const SupplementAnalysisSchema = z.object({
  nutrients: NutrientsField,
  notes: z.unknown().optional().transform((v) => (typeof v === "string" ? v : "")),
});

/** One-shot photo understanding: the model picks meal vs workout. */
export const PhotoAnalysisSchema = z
  .looseObject({ kind: z.unknown().optional() })
  .transform((raw) =>
    raw.kind === "workout"
      ? { kind: "workout" as const, workout: WorkoutAnalysisSchema.parse(raw) }
      : { kind: "meal" as const, meal: FoodAnalysisSchema.parse(raw) },
  );

// ---------------------------------------------------------------------------
// Document library (photographed lab results and reports)
// ---------------------------------------------------------------------------

/**
 * One measurement read off a document.
 *
 * `value` and `reference` stay strings on purpose: lab results say "negative",
 * "<5", "trace" and "30 - 400" as readily as they say numbers, and coercing
 * that to a float loses more than it gains. The coach reads them as text.
 */
export const DocumentValueSchema = z.object({
  name: z.unknown().transform((v) => (typeof v === "string" ? v.trim() : "")),
  value: z.unknown().transform((v) =>
    typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "",
  ),
  unit: z.unknown().optional().transform((v) => (typeof v === "string" ? v.trim() : "")),
  reference: z
    .unknown()
    .optional()
    .transform((v) => (typeof v === "string" ? v.trim() : "")),
  flag: z.enum(["low", "high", "normal", "unknown"]).catch("unknown"),
});
export type DocumentValue = z.infer<typeof DocumentValueSchema>;

/** A stored `documents.extracted` column; anything unreadable becomes []. */
export function parseDocumentValues(raw: unknown): DocumentValue[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((v) => {
    const r = DocumentValueSchema.safeParse(v);
    return r.success && r.data.name ? [r.data] : [];
  });
}

/**
 * A stored `documents.page_paths` column: filenames in the `photos` table, in order.
 *
 * Our own data, so anything that isn't a list of non-empty strings is dropped
 * rather than repaired: an unreadable list leaves the document on its
 * `photo_path`, which beats pointing the viewer at a file that isn't there.
 */
export function parseDocumentPages(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === "string" && v.length > 0);
}

/** Local day "YYYY-MM-DD", or null when the model couldn't find a date. */
const looseDay = z
  .unknown()
  .optional()
  .transform((v) =>
    typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? v.trim() : null,
  );

/** What the vision model returns for a photographed document. */
export const DocumentAnalysisSchema = z.object({
  title: looseTitle("Document"),
  kind: z.enum(["lab", "imaging", "report", "note", "other"]).catch("other"),
  document_date: looseDay,
  summary: looseDescription,
  values: z
    .unknown()
    .optional()
    .transform((v) => parseDocumentValues(v)),
});

// ---------------------------------------------------------------------------
// Open Food Facts API
// ---------------------------------------------------------------------------

/**
 * Individual fields stay `unknown`: OFF label data is messy, and the
 * per-field coercion lives in openFoodFacts.ts (str/num/mapOffNutriments).
 * The schema guarantees "object with these slots", nothing more. Loose, so
 * the per-language names we ask for (`product_name_da`, …) come through.
 */
export const OffProductSchema = z.looseObject({
  // zod v4 requires keys unless explicitly .optional(), even for unknown.
  code: z.unknown().optional(),
  product_name: z.unknown().optional(),
  brands: z.unknown().optional(),
  quantity: z.unknown().optional(),
  product_quantity: z.unknown().optional(),
  product_quantity_unit: z.unknown().optional(),
  serving_size: z.unknown().optional(),
  serving_quantity: z.unknown().optional(),
  nutriments: z.unknown().optional(),
  nutriscore_grade: z.unknown().optional(),
  ingredients_text: z.unknown().optional(),
  countries_tags: z.unknown().optional(),
});
export type OffProduct = z.infer<typeof OffProductSchema>;

/**
 * search.openfoodfacts.org response: the barcodes of its hits, best first.
 * null when the body isn't a search result at all (an error object, a web
 * page) — that's a failed search, not an empty one.
 */
export function parseOffSearchHits(raw: unknown): string[] | null {
  const r = z.object({ hits: z.array(z.unknown()) }).safeParse(raw);
  if (!r.success) return null;
  const Hit = z.object({ code: z.union([z.string(), z.number()]).optional() });
  return r.data.hits.flatMap((h) => {
    const q = Hit.safeParse(h);
    const code = q.success && q.data.code != null ? String(q.data.code).trim() : "";
    return /^\d+$/.test(code) ? [code] : [];
  });
}

/** Free-text search response: object entries of `products`, else []. */
export function parseOffSearchResponse(raw: unknown): OffProduct[] {
  const r = z.object({ products: z.array(z.unknown()).catch([]) }).safeParse(raw);
  if (!r.success) return [];
  return r.data.products.flatMap((p) => {
    const q = OffProductSchema.safeParse(p);
    return q.success ? [q.data] : [];
  });
}

/** Barcode lookup response: the single product when status === 1, else []. */
export function parseOffBarcodeResponse(raw: unknown): OffProduct[] {
  const r = z.object({ status: z.unknown().optional(), product: z.unknown().optional() }).safeParse(raw);
  if (!r.success || r.data.status !== 1) return [];
  const p = OffProductSchema.safeParse(r.data.product);
  return p.success ? [p.data] : [];
}

/** A positive amount the model sent, or undefined for anything else. */
const positiveAmount = z.coerce.number().positive().finite().optional().catch(undefined);

/**
 * log_meal's `label` argument: which product, and how much of it. Forgiving
 * on the amounts (an unusable one is just absent); the barcode has to be
 * digits, since a guessed product is worse than no product.
 */
export const LabelArgsSchema = z.object({
  barcode: z
    .union([z.string(), z.number()])
    .transform((v) => String(v).trim())
    .pipe(z.string().regex(/^\d+$/)),
  grams: positiveAmount,
  servings: positiveAmount,
  packages: positiveAmount,
});
export type LabelArgs = z.infer<typeof LabelArgsSchema>;

/** The `label` argument, or null when there is no usable barcode in it. */
export function parseLabelArgs(raw: unknown): LabelArgs | null {
  const r = LabelArgsSchema.safeParse(raw);
  return r.success ? r.data : null;
}

/**
 * One entry of log_performance's `stats` argument. Forgiving: a number sent
 * as a string is coerced, and an entry with no usable number or metric is
 * dropped rather than failing the whole call (see parsePerformanceStatArgs).
 */
const optionalText = z
  .unknown()
  .optional()
  .transform((v) => (typeof v === "string" && v.trim() ? v.trim() : null));

const PerformanceStatArgSchema = z.object({
  metric: z.string().trim().min(1),
  value: z.coerce.number().finite(),
  label: optionalText,
  unit: optionalText,
});
export type PerformanceStatArg = z.infer<typeof PerformanceStatArgSchema>;

/** The usable entries of log_performance's `stats`; [] when it isn't a list. */
export function parsePerformanceStatArgs(raw: unknown): PerformanceStatArg[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const r = PerformanceStatArgSchema.safeParse(item);
    return r.success ? [r.data] : [];
  });
}

// ---------------------------------------------------------------------------
// Settings blobs
// ---------------------------------------------------------------------------

/** Non-negative floored integer; else 0. */
const nonNegInt = z
  .unknown()
  .optional()
  .transform((v) =>
    typeof v === "number" && isFinite(v) && v > 0 ? Math.floor(v) : 0,
  );

/**
 * The coach's stance: what it pushes for and how it talks. Ours to keep, so
 * strict-ish — but every field defaults, because a half-written stance should
 * still produce a usable coach rather than none at all.
 */
const looseStringList = (max: number) =>
  z
    .array(z.unknown())
    .catch([])
    .transform((a) =>
      a
        .filter((v): v is string => typeof v === "string")
        .map((v) => v.trim())
        .filter((v) => v.length > 0)
        .slice(0, max),
    );

export const CoachStanceSchema = z.object({
  /** Ranked; the first is the primary focus. */
  imperatives: looseStringList(5),
  tone: z.enum(["gentle", "straight", "tough"]).catch("straight"),
  length: z.enum(["brief", "normal", "thorough"]).catch("normal"),
  /** Subjects the coach must never raise. */
  avoid: looseStringList(10),
  /** Anything else, in the user's own words. */
  notes: z.unknown().optional().transform((v) => (typeof v === "string" ? v.trim() : "")),
  /** Language to answer in; empty = follow whatever the user writes. */
  language: z.unknown().optional().transform((v) => (typeof v === "string" ? v.trim() : "")),
});

// ---------------------------------------------------------------------------
// Experiments (see lib/experiments.ts)
// ---------------------------------------------------------------------------

/**
 * Numbers the app reads for a trial from what's already logged. Kept here so
 * the persisted and the model-facing schemas share one list.
 */
export const AUTO_METRICS = [
  "fast_h",
  "refeed_kcal",
  "refeed_carbs_g",
  "refeed_protein_g",
  "sleep_h",
  "hrv_ms",
  "resting_hr",
  "weight_change_kg",
] as const;
export type AutoMetric = (typeof AUTO_METRICS)[number];

const ArmSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  detail: z.string(),
});
export type ExperimentArm = z.infer<typeof ArmSchema>;

const MeasureSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  /** rating = a 1–5 they give; auto = read from the diary (key is the metric). */
  kind: z.enum(["rating", "auto"]),
  better: z.enum(["higher", "lower"]),
});
export type ExperimentMeasure = z.infer<typeof MeasureSchema>;

/** Our own rows, so strict: a corrupt experiment should show, not shrink. */
const ArmsSchema = z.array(ArmSchema).min(1);
const MeasuresSchema = z.array(MeasureSchema);
const RatingsSchema = z.record(z.string(), z.number().int().min(1).max(5));
export type TrialRatings = z.infer<typeof RatingsSchema>;

export function parseExperimentArms(raw: string): ExperimentArm[] {
  return ArmsSchema.parse(parseJson(raw));
}

export function parseExperimentMeasures(raw: string): ExperimentMeasure[] {
  return MeasuresSchema.parse(parseJson(raw));
}

export function parseTrialRatings(raw: string | null): TrialRatings | null {
  return raw == null ? null : RatingsSchema.parse(parseJson(raw));
}

const looseLine = z
  .unknown()
  .transform((v) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ") : ""));

/** Turn a label into a measure key: "Gut feel" → "gut_feel". */
function slug(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 32) || "rating"
  );
}

/**
 * The coach's `design_experiment` arguments. Forgiving: options without a
 * label are dropped, keys are assigned A, B, C…, unknown auto metrics are
 * dropped and rating keys are made from their labels — a sloppy design
 * should come out smaller, not fail.
 */
export const ExperimentDesignSchema = z.object({
  title: looseLine,
  hypothesis: looseLine,
  applies_when: z.enum(["fasting", "none"]).catch("none"),
  arms: z
    .array(z.object({ label: looseLine, detail: looseLine.optional() }).catch({ label: "" }))
    .catch([])
    .transform((arms) =>
      arms
        .filter((a) => a.label)
        .slice(0, 4)
        .map((a, i) => ({
          key: String.fromCharCode(65 + i),
          label: a.label,
          detail: a.detail ?? "",
        })),
    ),
  ratings: z
    .array(
      z
        .object({
          label: looseLine,
          better: z.enum(["higher", "lower"]).catch("higher"),
        })
        .catch({ label: "", better: "higher" as const }),
    )
    .catch([])
    .transform((rs) => {
      const out: ExperimentMeasure[] = [];
      for (const r of rs) {
        if (!r.label) continue;
        let key = slug(r.label);
        while (out.some((m) => m.key === key)) key += "_";
        out.push({ key, label: r.label, kind: "rating", better: r.better });
      }
      return out.slice(0, 5);
    }),
  auto: z
    .array(z.unknown())
    .catch([])
    .transform((ms) => [
      ...new Set(
        ms.filter((m): m is AutoMetric => (AUTO_METRICS as readonly unknown[]).includes(m)),
      ),
    ]),
  assignment: z.enum(["balanced", "choose"]).catch("balanced"),
  target_per_arm: z.coerce
    .number()
    .catch(3)
    .transform((n) => (isFinite(n) ? Math.min(10, Math.max(1, Math.round(n))) : 3)),
});
export type ExperimentDesign = z.infer<typeof ExperimentDesignSchema>;

/**
 * Ratings as the coach passes them: measure key (or label) → 1–5. Forgiving:
 * numbers are rounded and clamped, anything that isn't one is dropped.
 */
export const RatingArgsSchema = z
  .record(z.string(), z.unknown())
  .catch({})
  .transform((r) => {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(r)) {
      const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
      if (isFinite(n)) out[k] = Math.min(5, Math.max(1, Math.round(n)));
    }
    return out;
  });

/**
 * Per-trigger check-in config (see lib/coachTriggers.ts). Every field is
 * optional and clamped: a stale or partial blob should degrade to the
 * trigger's own defaults, never disable the coach outright.
 */
export const TriggerConfigSchema = z.object({
  enabled: z.unknown().optional().transform((v) => (typeof v === "boolean" ? v : null)),
  hour: z
    .unknown()
    .optional()
    .transform((v) =>
      typeof v === "number" && isFinite(v) ? Math.min(23, Math.max(0, Math.round(v))) : null,
    ),
  threshold: z
    .unknown()
    .optional()
    .transform((v) => (typeof v === "number" && isFinite(v) && v >= 0 ? v : null)),
});

/** A map of trigger key → config; unknown keys are ignored downstream. */
export const CoachTriggersSchema = z.record(z.string(), TriggerConfigSchema).catch({});

/**
 * Which finished recaps have been seen (see lib/recap.ts): the first day of
 * the last week and month whose recap was opened or dismissed. Ours, so
 * strict — the caller treats a corrupt blob as nothing seen, which at worst
 * offers a recap twice.
 */
export const RecapSeenSchema = z.object({
  week: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  month: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
});

/** Streak-freeze bookkeeping (see lib/streak.ts). Tolerant: junk fields reset. */
export const StreakStateSchema = z.object({
  /**
   * The streak as last computed. Not needed by the engine — it recomputes
   * from the diary every time — but the scheduled Android check-in has no
   * JavaScript to recompute with, and a day-stale streak length is plenty for
   * "this is about to break".
   */
  current: nonNegInt,
  freezes: nonNegInt,
  frozenDays: z
    .array(z.unknown())
    .catch([])
    .transform((a) => a.filter((d): d is string => typeof d === "string")),
  lastEarnedStreak: nonNegInt,
  /**
   * Longest streak ever seen. Kept because it can't be recomputed: freezes
   * that bridged an old streak are pruned once it ends, so re-deriving it
   * from the diary would split that run at its frozen days.
   */
  best: nonNegInt,
});

// ---------------------------------------------------------------------------
// Garmin Connect (unofficial API, via the Rust `garmin_*` commands)
//
// Forgiving throughout: Garmin's answers are undocumented and change shape, so
// every field degrades to null rather than failing the sync. Garmin uses
// negative sentinels (-1, -2) for "no data" in stress and Body Battery.
// ---------------------------------------------------------------------------

const gNum = z.number().nullish().catch(null).transform((v) => v ?? null);
/** Garmin's "no reading" sentinels are negative. */
const gLevel = gNum.transform((v) => (v != null && v >= 0 ? v : null));
const gStr = z.string().nullish().catch(null).transform((v) => v ?? null);
const gId = z
  .union([z.number(), z.string()])
  .nullish()
  .catch(null)
  .transform((v) => (v == null || v === "" ? null : String(v)));

/** The `{code, message}` a failed `garmin_*` command rejects with. */
export const GarminCmdErrorSchema = z.object({ code: z.string(), message: z.string() });
export type GarminCmdError = z.infer<typeof GarminCmdErrorSchema>;

export function parseGarminCmdError(raw: unknown): GarminCmdError {
  const r = GarminCmdErrorSchema.safeParse(raw);
  if (r.success) return r.data;
  return { code: "unknown", message: raw instanceof Error ? raw.message : String(raw) };
}

export const GarminStatusSchema = z.object({
  /** The official Personal API key is set. */
  personal: z.boolean().catch(false),
  /** The unofficial sign-in is active (training readiness/status only). */
  connected: z.boolean().catch(false),
  mfaPending: z.boolean().catch(false),
});
export type GarminStatus = z.infer<typeof GarminStatusSchema>;

export function parseGarminStatus(raw: unknown): GarminStatus {
  return GarminStatusSchema.catch({ personal: false, connected: false, mfaPending: false }).parse(raw);
}

export function parseGarminLoginResult(raw: unknown): "connected" | "mfa" {
  return z.object({ status: z.enum(["connected", "mfa"]) }).parse(raw).status;
}

export function parseGarminProfile(raw: unknown): string | null {
  return z.looseObject({ displayName: gStr }).catch({ displayName: null }).parse(raw).displayName;
}

/** One row of /activitylist-service/activities/search/activities. */
export const GarminActivitySchema = z
  .looseObject({
    activityId: gId,
    activityName: gStr,
    startTimeLocal: gStr,
    startTimeGMT: gStr,
    beginTimestamp: gNum,
    activityType: z.looseObject({ typeKey: gStr }).nullish().catch(null),
    distance: gNum,
    duration: gNum,
    elevationGain: gNum,
    averageSpeed: gNum,
    averageHR: gNum,
    maxHR: gNum,
    calories: gNum,
    bmrCalories: gNum,
    aerobicTrainingEffect: gNum,
    anaerobicTrainingEffect: gNum,
    trainingEffectLabel: gStr,
    activityTrainingLoad: gNum,
    avgPower: gNum,
    maxPower: gNum,
    normPower: gNum,
    averageRunningCadenceInStepsPerMinute: gNum,
    averageBikingCadenceInRevPerMinute: gNum,
    vO2MaxValue: gNum,
    hrTimeInZone_1: gNum,
    hrTimeInZone_2: gNum,
    hrTimeInZone_3: gNum,
    hrTimeInZone_4: gNum,
    hrTimeInZone_5: gNum,
  })
  .transform((a) => {
    // "YYYY-MM-DD HH:MM:SS" with no zone — GMT and local both, which is how
    // the offset it was done in can be recovered.
    const gmtMs = a.startTimeGMT ? Date.parse(a.startTimeGMT.replace(" ", "T") + "Z") : NaN;
    const localMs = a.startTimeLocal ? Date.parse(a.startTimeLocal.replace(" ", "T") + "Z") : NaN;
    const startMs = a.beginTimestamp ?? (isFinite(gmtMs) ? gmtMs : null);
    const offsetMin =
      isFinite(gmtMs) && isFinite(localMs) ? Math.round((localMs - gmtMs) / 60_000) : null;
    const zones = [a.hrTimeInZone_1, a.hrTimeInZone_2, a.hrTimeInZone_3, a.hrTimeInZone_4, a.hrTimeInZone_5];
    return {
      id: a.activityId,
      name: a.activityName,
      typeKey: a.activityType?.typeKey ?? null,
      startMs,
      offsetMin,
      durationSec: a.duration,
      distanceM: a.distance,
      elevationGainM: a.elevationGain,
      avgSpeedMps: a.averageSpeed,
      avgHr: a.averageHR,
      maxHr: a.maxHR,
      calories: a.calories,
      /** Active burn, like Health Connect's — the BMR share taken out. */
      activeCalories:
        a.calories != null ? Math.max(0, a.calories - (a.bmrCalories ?? 0)) : null,
      aerobicTe: a.aerobicTrainingEffect,
      anaerobicTe: a.anaerobicTrainingEffect,
      teLabel: a.trainingEffectLabel,
      trainingLoad: a.activityTrainingLoad,
      avgPower: a.avgPower,
      maxPower: a.maxPower,
      normPower: a.normPower,
      avgCadence: a.averageRunningCadenceInStepsPerMinute ?? a.averageBikingCadenceInRevPerMinute,
      vo2Max: a.vO2MaxValue,
      zoneSecs: zones.some((z) => z != null) ? zones.map((z) => z ?? 0) : null,
    };
  });
export type GarminActivity = z.infer<typeof GarminActivitySchema>;

/** The activity list; rows without an id or a start are dropped. */
export function parseGarminActivities(raw: unknown): {
  activities: (GarminActivity & { id: string; startMs: number })[];
  raws: Record<string, unknown>[];
} {
  const rows = z.array(z.unknown()).catch([]).parse(raw);
  const activities: (GarminActivity & { id: string; startMs: number })[] = [];
  const raws: Record<string, unknown>[] = [];
  for (const row of rows) {
    const r = GarminActivitySchema.safeParse(row);
    const obj = z.record(z.string(), z.unknown()).safeParse(row);
    if (!r.success || !obj.success) continue;
    const a = r.data;
    if (a.id == null || a.startMs == null) continue;
    activities.push({ ...a, id: a.id, startMs: a.startMs });
    raws.push(obj.data);
  }
  return { activities, raws };
}

/** A lap as stored in `garmin_activities.laps` (our data — strict). */
export const GarminLapSchema = z.object({
  index: z.number(),
  startMs: z.number().nullable(),
  durationSec: z.number().nullable(),
  distanceM: z.number().nullable(),
  avgHr: z.number().nullable(),
  maxHr: z.number().nullable(),
  avgSpeedMps: z.number().nullable(),
  avgPower: z.number().nullable(),
  avgCadence: z.number().nullable(),
  elevationGainM: z.number().nullable(),
  calories: z.number().nullable(),
});
export type GarminLap = z.infer<typeof GarminLapSchema>;

/** The laps `garmin_activity_laps` read out of an activity's FIT file. */
export function parseGarminLaps(raw: unknown): GarminLap[] {
  const Lap = z.object({
    index: z.number(),
    startMs: gNum,
    durationSec: gNum,
    distanceM: gNum,
    avgHr: gNum,
    maxHr: gNum,
    avgSpeedMps: gNum,
    avgPower: gNum,
    avgCadence: gNum,
    elevationGainM: gNum,
    calories: gNum,
  });
  return z
    .array(Lap.nullable().catch(null))
    .catch([])
    .parse(raw)
    .filter((l) => l != null);
}

/** Stored `garmin_activities.laps`; null = not fetched or corrupt. */
export function parseStoredGarminLaps(raw: unknown): GarminLap[] | null {
  const r = z.array(GarminLapSchema).safeParse(raw);
  return r.success ? r.data : null;
}

/** Stored `garmin_activities.zone_secs`; null = none or corrupt. */
export function parseStoredZoneSecs(raw: unknown): number[] | null {
  const r = z.array(z.number()).length(5).safeParse(raw);
  return r.success ? r.data : null;
}

/** An object, or null — for keeping endpoint answers verbatim. */
export function asJsonObject(raw: unknown): Record<string, unknown> | null {
  const r = z.record(z.string(), z.unknown()).safeParse(raw);
  return r.success ? r.data : null;
}

/** /usersummary-service/usersummary/daily/{displayName}?calendarDate= */
export function parseGarminDailySummary(raw: unknown) {
  return z
    .looseObject({
      totalSteps: gNum,
      totalKilocalories: gNum,
      activeKilocalories: gNum,
      restingHeartRate: gNum,
      minHeartRate: gNum,
      maxHeartRate: gNum,
      averageStressLevel: gLevel,
      maxStressLevel: gLevel,
      bodyBatteryHighestValue: gLevel,
      bodyBatteryLowestValue: gLevel,
      bodyBatteryChargedValue: gLevel,
      bodyBatteryDrainedValue: gLevel,
      bodyBatteryAtWakeTime: gLevel,
      avgWakingRespirationValue: gLevel,
      averageSpo2: gLevel,
      lowestSpo2: gLevel,
      floorsAscended: gNum,
      moderateIntensityMinutes: gNum,
      vigorousIntensityMinutes: gNum,
    })
    .nullable()
    .catch(null)
    .parse(raw);
}
export type GarminDailySummary = NonNullable<ReturnType<typeof parseGarminDailySummary>>;

/**
 * A timestamp Garmin gives as epoch ms — a number, a numeric string — or as a
 * date-time string, with or without a zone (none = UTC, or wall-clock for the
 * "Local" twins, which are only ever compared with their GMT sibling).
 */
const gMs = z
  .union([z.number(), z.string()])
  .nullish()
  .catch(null)
  .transform((v) => {
    if (v == null || v === "") return null;
    if (typeof v === "number") return isFinite(v) ? v : null;
    if (/^\d+$/.test(v)) return Number(v);
    const zoned = /([zZ]|[+-]\d\d:?\d\d)$/.test(v) ? v : `${v.replace(" ", "T")}Z`;
    const ms = Date.parse(zoned);
    return isFinite(ms) ? ms : null;
  });

const SleepDtoSchema = z.looseObject({
  id: gId,
  calendarDate: gStr,
  sleepStartTimestampGMT: gMs,
  sleepEndTimestampGMT: gMs,
  sleepEndTimestampLocal: gMs,
  deepSleepSeconds: gNum,
  lightSleepSeconds: gNum,
  remSleepSeconds: gNum,
  awakeSleepSeconds: gNum,
  averageRespirationValue: gLevel,
  avgSleepStress: gLevel,
  sleepScores: z
    .looseObject({ overall: z.looseObject({ value: gNum }).nullish().catch(null) })
    .nullish()
    .catch(null),
});

export interface GarminSleep {
  /** Garmin's calendar date for the night — the morning it ended. */
  day: string | null;
  night: {
    id: string;
    startMs: number;
    endMs: number;
    offsetMin: number | null;
    deepMin: number | null;
    remMin: number | null;
    lightMin: number | null;
    awakeMin: number | null;
  } | null;
  score: number | null;
  respiration: number | null;
  stress: number | null;
  bodyBatteryChange: number | null;
  raw: Record<string, unknown> | null;
}

function sleepOf(d: z.infer<typeof SleepDtoSchema> | null | undefined, bodyBatteryChange: number | null, raw: Record<string, unknown> | null): GarminSleep {
  const night =
    d && d.id != null && d.sleepStartTimestampGMT != null && d.sleepEndTimestampGMT != null &&
    d.sleepEndTimestampGMT > d.sleepStartTimestampGMT
      ? {
          id: d.id,
          startMs: d.sleepStartTimestampGMT,
          endMs: d.sleepEndTimestampGMT,
          offsetMin:
            d.sleepEndTimestampLocal != null
              ? Math.round((d.sleepEndTimestampLocal - d.sleepEndTimestampGMT) / 60_000)
              : null,
          deepMin: d.deepSleepSeconds != null ? d.deepSleepSeconds / 60 : null,
          remMin: d.remSleepSeconds != null ? d.remSleepSeconds / 60 : null,
          lightMin: d.lightSleepSeconds != null ? d.lightSleepSeconds / 60 : null,
          awakeMin: d.awakeSleepSeconds != null ? d.awakeSleepSeconds / 60 : null,
        }
      : null;
  return {
    day: d?.calendarDate ?? null,
    night,
    score: d?.sleepScores?.overall?.value ?? null,
    respiration: d?.averageRespirationValue ?? null,
    stress: d?.avgSleepStress ?? null,
    bodyBatteryChange,
    raw,
  };
}

/** An object with its arrays (per-minute series) left out. */
function withoutSeries(raw: unknown): Record<string, unknown> | null {
  const obj = asJsonObject(raw);
  return obj ? Object.fromEntries(Object.entries(obj).filter(([, v]) => !Array.isArray(v))) : null;
}

/**
 * Unofficial /wellness-service/wellness/dailySleepData/{displayName}?date= —
 * the night ending on that date.
 */
export function parseGarminSleep(raw: unknown): GarminSleep {
  const parsed = z
    .looseObject({ dailySleepDTO: SleepDtoSchema.nullish().catch(null), bodyBatteryChange: gNum })
    .nullable()
    .catch(null)
    .parse(raw);
  return sleepOf(parsed?.dailySleepDTO, parsed?.bodyBatteryChange ?? null, withoutSeries(raw));
}

/** Personal API /sleep-service/sleep/dailySleepSummariesByDate → one per night. */
export function parseGarminSleepList(raw: unknown): GarminSleep[] {
  return z
    .array(z.unknown())
    .catch([])
    .parse(raw)
    .map((row) => {
      const d = SleepDtoSchema.nullable().catch(null).parse(row);
      return sleepOf(d, null, withoutSeries(row));
    })
    .filter((s) => s.day != null);
}

/** /hrv-service/hrv/{date} — the summary; the 5-minute readings are dropped. */
export function parseGarminHrv(raw: unknown) {
  const s = z
    .looseObject({
      hrvSummary: z
        .looseObject({ lastNightAvg: gNum, weeklyAvg: gNum, status: gStr })
        .nullish()
        .catch(null),
    })
    .nullable()
    .catch(null)
    .parse(raw)?.hrvSummary;
  return {
    lastNight: s?.lastNightAvg ?? null,
    weeklyAvg: s?.weeklyAvg ?? null,
    status: s?.status ?? null,
    raw: s ? asJsonObject(s) : null,
  };
}

/** Personal API /hrv-service/hrv/daily/{from}/{to} → per day. */
export function parseGarminHrvDaily(
  raw: unknown,
): Map<string, { lastNight: number | null; weeklyAvg: number | null; status: string | null; raw: Record<string, unknown> | null }> {
  const rows = z
    .looseObject({ hrvSummaries: z.array(z.unknown()).catch([]) })
    .catch({ hrvSummaries: [] })
    .parse(raw).hrvSummaries;
  const out = new Map<string, { lastNight: number | null; weeklyAvg: number | null; status: string | null; raw: Record<string, unknown> | null }>();
  for (const row of rows) {
    const s = z
      .looseObject({ calendarDate: gStr, lastNightAvg: gNum, weeklyAvg: gNum, status: gStr })
      .nullable()
      .catch(null)
      .parse(row);
    if (!s?.calendarDate) continue;
    out.set(s.calendarDate, {
      lastNight: s.lastNightAvg,
      weeklyAvg: s.weeklyAvg,
      status: s.status,
      raw: asJsonObject(row),
    });
  }
  return out;
}

const V2Value = z.looseObject({ value: gNum }).nullish().catch(null);

const DailySummaryV2Schema = z.looseObject({
  calendarDate: gStr,
  movement: z
    .looseObject({ steps: V2Value, floorsAscended: V2Value })
    .nullish()
    .catch(null),
  calories: z
    .looseObject({ burnedTotal: gNum, burnedActive: gNum })
    .nullish()
    .catch(null),
  heartRate: z
    .looseObject({ minValue: gNum, maxValue: gNum, restingValue: gNum })
    .nullish()
    .catch(null),
  intensityMinutes: z.looseObject({ moderate: gNum, vigorous: gNum }).nullish().catch(null),
  stress: z.looseObject({ avgLevel: gLevel, maxLevel: gLevel }).nullish().catch(null),
  bodyBattery: z
    .looseObject({ minValue: gLevel, maxValue: gLevel, chargedValue: gLevel, drainedValue: gLevel })
    .nullish()
    .catch(null),
  respiration: z.looseObject({ avgValue: gLevel }).nullish().catch(null),
  pulseOx: z.looseObject({ avgValue: gLevel, minValue: gLevel }).nullish().catch(null),
});

export interface GarminDailySummaryV2 {
  steps: number | null;
  floors: number | null;
  caloriesTotal: number | null;
  caloriesActive: number | null;
  restingHr: number | null;
  minHr: number | null;
  maxHr: number | null;
  stressAvg: number | null;
  stressMax: number | null;
  bodyBatteryHigh: number | null;
  bodyBatteryLow: number | null;
  bodyBatteryCharged: number | null;
  bodyBatteryDrained: number | null;
  respirationAvg: number | null;
  spo2Avg: number | null;
  spo2Low: number | null;
  intensityModerate: number | null;
  intensityVigorous: number | null;
  raw: Record<string, unknown> | null;
}

/** Personal API /usersummary-service/v2/dailysummaries → per day. */
export function parseGarminDailySummariesV2(raw: unknown): Map<string, GarminDailySummaryV2> {
  const rows = z
    .looseObject({ data: z.array(z.unknown()).catch([]) })
    .catch({ data: [] })
    .parse(raw).data;
  const out = new Map<string, GarminDailySummaryV2>();
  for (const row of rows) {
    const d = DailySummaryV2Schema.nullable().catch(null).parse(row);
    if (!d?.calendarDate) continue;
    out.set(d.calendarDate, {
      steps: d.movement?.steps?.value ?? null,
      floors: d.movement?.floorsAscended?.value ?? null,
      caloriesTotal: d.calories?.burnedTotal ?? null,
      caloriesActive: d.calories?.burnedActive ?? null,
      restingHr: d.heartRate?.restingValue ?? null,
      minHr: d.heartRate?.minValue ?? null,
      maxHr: d.heartRate?.maxValue ?? null,
      stressAvg: d.stress?.avgLevel ?? null,
      stressMax: d.stress?.maxLevel ?? null,
      bodyBatteryHigh: d.bodyBattery?.maxValue ?? null,
      bodyBatteryLow: d.bodyBattery?.minValue ?? null,
      bodyBatteryCharged: d.bodyBattery?.chargedValue ?? null,
      bodyBatteryDrained: d.bodyBattery?.drainedValue ?? null,
      respirationAvg: d.respiration?.avgValue ?? null,
      spo2Avg: d.pulseOx?.avgValue ?? null,
      spo2Low: d.pulseOx?.minValue ?? null,
      intensityModerate: d.intensityMinutes?.moderate ?? null,
      intensityVigorous: d.intensityMinutes?.vigorous ?? null,
      raw: asJsonObject(row),
    });
  }
  return out;
}

/** /metrics-service/metrics/trainingreadiness/{date} — the day's latest. */
export function parseGarminReadiness(raw: unknown) {
  const rows = z
    .array(
      z
        .looseObject({ score: gNum, level: gStr, timestamp: gStr, timestampLocal: gStr })
        .nullable()
        .catch(null),
    )
    .catch([])
    .parse(raw)
    .filter((r) => r != null && r.score != null);
  rows.sort((a, b) => String(b?.timestamp ?? "").localeCompare(String(a?.timestamp ?? "")));
  const latest = rows[0] ?? null;
  return { score: latest?.score ?? null, level: latest?.level ?? null };
}

/**
 * /metrics-service/metrics/trainingstatus/aggregated/{date} — status, acute
 * and chronic load, and VO2 max, from the primary device's entry.
 */
export function parseGarminTrainingStatus(raw: unknown) {
  const Device = z.looseObject({
    trainingStatusFeedbackPhrase: gStr,
    primaryTrainingDevice: z.boolean().nullish().catch(null),
    acuteTrainingLoadDTO: z
      .looseObject({ dailyTrainingLoadAcute: gNum, dailyTrainingLoadChronic: gNum })
      .nullish()
      .catch(null),
  });
  const parsed = z
    .looseObject({
      mostRecentVO2Max: z
        .looseObject({
          generic: z
            .looseObject({ vo2MaxPreciseValue: gNum, vo2MaxValue: gNum })
            .nullish()
            .catch(null),
        })
        .nullish()
        .catch(null),
      mostRecentTrainingStatus: z
        .looseObject({
          latestTrainingStatusData: z
            .record(z.string(), Device.nullable().catch(null))
            .nullish()
            .catch(null),
        })
        .nullish()
        .catch(null),
    })
    .nullable()
    .catch(null)
    .parse(raw);
  const devices = Object.values(
    parsed?.mostRecentTrainingStatus?.latestTrainingStatusData ?? {},
  ).filter((d) => d != null);
  const dev = devices.find((d) => d?.primaryTrainingDevice) ?? devices[0] ?? null;
  const vo2 = parsed?.mostRecentVO2Max?.generic;
  return {
    // "PRODUCTIVE_3" → "PRODUCTIVE": the suffix only picks Garmin's sentence.
    status: dev?.trainingStatusFeedbackPhrase?.replace(/_\d+$/, "") ?? null,
    acuteLoad: dev?.acuteTrainingLoadDTO?.dailyTrainingLoadAcute ?? null,
    chronicLoad: dev?.acuteTrainingLoadDTO?.dailyTrainingLoadChronic ?? null,
    vo2Max: vo2?.vo2MaxPreciseValue ?? vo2?.vo2MaxValue ?? null,
    raw: asJsonObject(raw),
  };
}

/**
 * Garmin's own load focus, from the same training-status answer: the last
 * four weeks' load split into low aerobic, high aerobic and anaerobic, each
 * with the personal target range Garmin sets for it, and its one-line verdict
 * ("AEROBIC_HIGH_SHORTAGE"). Read back from the stored answer (garmin_days
 * raw.trainingStatus); forgiving like the rest of Garmin's output — null when
 * it isn't there.
 */
export function parseGarminLoadBalance(raw: unknown) {
  const Entry = z.looseObject({
    primaryTrainingDevice: z.boolean().nullish().catch(null),
    monthlyLoadAerobicLow: gNum,
    monthlyLoadAerobicHigh: gNum,
    monthlyLoadAnaerobic: gNum,
    monthlyLoadAerobicLowTargetMin: gNum,
    monthlyLoadAerobicLowTargetMax: gNum,
    monthlyLoadAerobicHighTargetMin: gNum,
    monthlyLoadAerobicHighTargetMax: gNum,
    monthlyLoadAnaerobicTargetMin: gNum,
    monthlyLoadAnaerobicTargetMax: gNum,
    trainingBalanceFeedbackPhrase: gStr,
  });
  const parsed = z
    .looseObject({
      mostRecentTrainingLoadBalance: z
        .looseObject({
          metricsTrainingLoadBalanceDTOMap: z
            .record(z.string(), Entry.nullable().catch(null))
            .nullish()
            .catch(null),
        })
        .nullish()
        .catch(null),
    })
    .nullable()
    .catch(null)
    .parse(raw);
  const entries = Object.values(
    parsed?.mostRecentTrainingLoadBalance?.metricsTrainingLoadBalanceDTOMap ?? {},
  ).filter((e) => e != null);
  const e = entries.find((x) => x?.primaryTrainingDevice) ?? entries[0] ?? null;
  if (!e || (e.monthlyLoadAerobicLow == null && e.monthlyLoadAerobicHigh == null && e.monthlyLoadAnaerobic == null)) {
    return null;
  }
  const range = (min: number | null, max: number | null) =>
    min != null && max != null && max >= min ? { min, max } : null;
  return {
    low: e.monthlyLoadAerobicLow ?? 0,
    high: e.monthlyLoadAerobicHigh ?? 0,
    anaerobic: e.monthlyLoadAnaerobic ?? 0,
    lowTarget: range(e.monthlyLoadAerobicLowTargetMin, e.monthlyLoadAerobicLowTargetMax),
    highTarget: range(e.monthlyLoadAerobicHighTargetMin, e.monthlyLoadAerobicHighTargetMax),
    anaerobicTarget: range(e.monthlyLoadAnaerobicTargetMin, e.monthlyLoadAnaerobicTargetMax),
    // "AEROBIC_HIGH_SHORTAGE_2" → "AEROBIC_HIGH_SHORTAGE".
    feedback: e.trainingBalanceFeedbackPhrase?.replace(/_\d+$/, "") ?? null,
  };
}
export type GarminLoadBalance = NonNullable<ReturnType<typeof parseGarminLoadBalance>>;

/** The `trainingStatus` answer inside a stored garmin_days `raw` blob. */
export function parseStoredTrainingStatusRaw(raw: unknown): unknown {
  return z.looseObject({ trainingStatus: z.unknown() }).nullable().catch(null).parse(raw)?.trainingStatus ?? null;
}

/**
 * Weight per day, kg — /weight-service/weight/dateRange (unofficial) and
 * /weight-service/weight/range/{start}/{end} (Personal API) share the shape.
 * Garmin reports grams; a value that already looks like kg is kept.
 */
export function parseGarminWeights(raw: unknown): Map<string, number> {
  const rows = z
    .looseObject({
      dailyWeightSummaries: z
        .array(
          z
            .looseObject({
              summaryDate: gStr,
              latestWeight: z.looseObject({ weight: gNum }).nullish().catch(null),
            })
            .nullable()
            .catch(null),
        )
        .catch([]),
    })
    .catch({ dailyWeightSummaries: [] })
    .parse(raw).dailyWeightSummaries;
  const out = new Map<string, number>();
  for (const r of rows) {
    const g = r?.latestWeight?.weight;
    if (r?.summaryDate && g != null && g > 0) out.set(r.summaryDate, g > 1000 ? g / 1000 : g);
  }
  return out;
}
