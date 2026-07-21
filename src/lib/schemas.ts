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
// Open Food Facts API
// ---------------------------------------------------------------------------

/**
 * Individual fields stay `unknown`: OFF label data is messy, and the
 * per-field coercion lives in openFoodFacts.ts (str/num/mapOffNutriments).
 * The schema guarantees "object with these slots", nothing more.
 */
export const OffProductSchema = z.object({
  // zod v4 requires keys unless explicitly .optional(), even for unknown.
  code: z.unknown().optional(),
  product_name: z.unknown().optional(),
  brands: z.unknown().optional(),
  quantity: z.unknown().optional(),
  serving_size: z.unknown().optional(),
  serving_quantity: z.unknown().optional(),
  nutriments: z.unknown().optional(),
  nutriscore_grade: z.unknown().optional(),
  ingredients_text: z.unknown().optional(),
});
export type OffProduct = z.infer<typeof OffProductSchema>;

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

/** Streak-freeze bookkeeping (see lib/streak.ts). Tolerant: junk fields reset. */
export const StreakStateSchema = z.object({
  freezes: nonNegInt,
  frozenDays: z
    .array(z.unknown())
    .catch([])
    .transform((a) => a.filter((d): d is string => typeof d === "string")),
  lastEarnedStreak: nonNegInt,
});
