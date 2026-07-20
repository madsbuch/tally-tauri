import { fetch } from "@tauri-apps/plugin-http";
import type { FoodAnalysis, Nutrients, ORModel, WorkoutAnalysis } from "./types";
import { NUTRIENT_DEFS, sanitizeNutrients } from "./nutrients";

const BASE = "https://openrouter.ai/api/v1";

/** Headers OpenRouter uses for app attribution. */
const APP_HEADERS = {
  "HTTP-Referer": "https://github.com/madsbuch/tally",
  "X-Title": "Tally",
};

export class OpenRouterError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "OpenRouterError";
    this.status = status;
  }
}

/** Fetch the live model list (no API key required). */
export async function fetchModels(): Promise<ORModel[]> {
  const res = await fetch(`${BASE}/models`, {
    method: "GET",
    headers: { ...APP_HEADERS },
  });
  if (!res.ok) {
    throw new OpenRouterError(`Model list request failed (HTTP ${res.status})`, res.status);
  }
  const json = (await res.json()) as { data?: ORModel[] };
  if (!Array.isArray(json.data)) {
    throw new OpenRouterError("Unexpected /models response shape", res.status);
  }
  return json.data;
}

/** True when the model accepts image input. */
export function isVisionModel(m: ORModel): boolean {
  return m.architecture?.input_modalities?.includes("image") ?? false;
}

/** Rough $/1M prompt tokens for sorting/display; null when unknown or free. */
export function promptPricePerMillion(m: ORModel): number | null {
  const p = m.pricing?.prompt;
  if (p == null) return null;
  const perToken = parseFloat(p);
  // "-1" is OpenRouter's variable-pricing sentinel — treat as unknown.
  if (!isFinite(perToken) || perToken < 0) return null;
  return perToken * 1_000_000;
}

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

/** OpenAI-style function tool definition (OpenRouter `tools` parameter). */
export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface AssistantTurn {
  content: string | null;
  tool_calls: ToolCall[];
}

interface ChatResponse {
  choices?: {
    message?: { content?: string | null; tool_calls?: ToolCall[] };
    finish_reason?: string;
    error?: { message?: string; code?: number | string };
  }[];
  error?: { message?: string; code?: number | string };
}

/**
 * Tool-calling chat turn: returns the assistant message with any tool calls.
 * Used by the diary agent (src/lib/agent.ts).
 */
export async function chatWithTools(
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  tools: ToolDef[],
): Promise<AssistantTurn> {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...APP_HEADERS,
    },
    body: JSON.stringify({ model, messages, tools }),
  });
  const json = (await res.json().catch(() => ({}))) as ChatResponse;
  if (!res.ok || json.error) {
    const msg = json.error?.message ?? `HTTP ${res.status}`;
    throw new OpenRouterError(`OpenRouter request failed: ${msg}`, res.status);
  }
  const choice = json.choices?.[0];
  if (choice?.error || choice?.finish_reason === "error") {
    throw new OpenRouterError(
      `Model error: ${choice.error?.message ?? "provider returned an error"}`,
      res.status,
    );
  }
  return {
    content: typeof choice?.message?.content === "string" ? choice.message.content : null,
    tool_calls: choice?.message?.tool_calls ?? [],
  };
}

/** True when the model advertises OpenAI-style tool calling. */
export function supportsTools(m: ORModel): boolean {
  return m.supported_parameters?.includes("tools") ?? false;
}

/** Low-level chat completion; returns the assistant message content. */
export async function chat(
  apiKey: string,
  model: string,
  messages: ChatMessage[],
): Promise<string> {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...APP_HEADERS,
    },
    body: JSON.stringify({ model, messages }),
  });
  const json = (await res.json().catch(() => ({}))) as ChatResponse;
  if (!res.ok || json.error) {
    const msg = json.error?.message ?? `HTTP ${res.status}`;
    throw new OpenRouterError(`OpenRouter request failed: ${msg}`, res.status);
  }
  const choice = json.choices?.[0];
  // Providers can embed per-choice errors in HTTP 200 responses.
  if (choice?.error || choice?.finish_reason === "error") {
    throw new OpenRouterError(
      `Model error: ${choice.error?.message ?? "provider returned an error"}`,
      res.status,
    );
  }
  const content = choice?.message?.content;
  if (typeof content !== "string" || content.length === 0) {
    throw new OpenRouterError("Model returned an empty response", res.status);
  }
  return content;
}

function nutrientKeyDoc(): string {
  return NUTRIENT_DEFS.map((d) => `"${d.key}": number (${d.unit})`).join(", ");
}

/** Extract the first JSON object from model output (tolerates fences/prose). */
export function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("No JSON object found in model response");
  }
  return JSON.parse(text.slice(start, end + 1));
}

export interface AnalyzeFoodOptions {
  apiKey: string;
  model: string;
  /** JPEG data URL of the meal photo. */
  imageDataUrl?: string;
  /** Optional user note, e.g. "the bowl is about 500 ml". */
  hint?: string;
}

/**
 * Ask a vision model to estimate macro- and micronutrients for a meal photo
 * and/or text description. Either `imageDataUrl` or `hint` must be provided.
 */
export async function analyzeFood(opts: AnalyzeFoodOptions): Promise<FoodAnalysis> {
  const { apiKey, model, imageDataUrl, hint } = opts;
  if (!imageDataUrl && !hint) {
    throw new Error("Provide a photo or a description to analyze");
  }

  const system = [
    "You are a meticulous nutritionist estimating the nutritional content of a meal.",
    "Estimate the TOTAL amounts for the entire visible portion.",
    "Respond with a SINGLE JSON object and nothing else - no markdown, no code fences.",
    "Schema:",
    `{"title": string (short meal name, max 5 words),`,
    `"description": string (1-2 sentences: what the meal is and your portion-size assumptions),`,
    `"confidence": "low" | "medium" | "high",`,
    `"nutrients": {${nutrientKeyDoc()}}}`,
    "In `nutrients`, include every key you can reasonably estimate and omit keys you cannot.",
    "All amounts must be plain non-negative numbers in the unit given for that key.",
  ].join("\n");

  const parts: ContentPart[] = [];
  parts.push({
    type: "text",
    text: hint
      ? `Analyze this meal. Note from the user: ${hint}`
      : "Analyze the meal in this photo.",
  });
  if (imageDataUrl) {
    parts.push({ type: "image_url", image_url: { url: imageDataUrl } });
  }

  const content = await chat(apiKey, model, [
    { role: "system", content: system },
    { role: "user", content: parts },
  ]);

  const raw = extractJsonObject(content) as {
    title?: unknown;
    description?: unknown;
    confidence?: unknown;
    nutrients?: unknown;
  };

  const confidence =
    raw.confidence === "low" || raw.confidence === "medium" || raw.confidence === "high"
      ? raw.confidence
      : "low";

  const nutrients: Nutrients = sanitizeNutrients(raw.nutrients);

  return {
    title: typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : "Meal",
    description: typeof raw.description === "string" ? raw.description.trim() : "",
    confidence,
    nutrients,
  };
}

export type PhotoAnalysis =
  | { kind: "meal"; meal: FoodAnalysis }
  | { kind: "workout"; workout: WorkoutAnalysis };

export interface AnalyzePhotoOptions {
  apiKey: string;
  model: string;
  /** JPEG data URL of whatever the user photographed. */
  imageDataUrl?: string;
  /** Optional user note. */
  hint?: string;
}

/**
 * One-shot photo understanding: the model decides whether the picture is FOOD
 * (a meal/snack/drink) or a WORKOUT (screenshot of a fitness app / cardio
 * machine display) and returns the matching analysis. Photo-first UX — the
 * user never has to pick a category.
 */
export async function analyzePhoto(opts: AnalyzePhotoOptions): Promise<PhotoAnalysis> {
  const { apiKey, model, imageDataUrl, hint } = opts;
  if (!imageDataUrl && !hint) {
    throw new Error("Provide a photo or a note to analyze");
  }

  const system = [
    "You are a health-tracking assistant. First decide what the image (or note) shows:",
    '- "meal": food or drink to be eaten -> estimate nutrition as a meticulous nutritionist (TOTAL amounts for the visible portion).',
    '- "workout": a workout-app screenshot, sports watch or cardio-machine display -> extract the exercise session.',
    "Respond with a SINGLE JSON object and nothing else - no markdown, no code fences.",
    "Schema:",
    `{"kind": "meal" | "workout",`,
    `"title": string (short name, max 5 words),`,
    `"description": string (1-2 sentences: what you see and your assumptions),`,
    `"confidence": "low" | "medium" | "high",`,
    `"nutrients": {${nutrientKeyDoc()}} (meal only; include keys you can estimate, omit the rest),`,
    `"calories_burned": number (workout only; kcal, read exactly when shown, else estimate),`,
    `"duration_min": number | null (workout only; total minutes)}`,
    "If the image is ambiguous, pick the most likely kind and set confidence to \"low\".",
  ].join("\n");

  const parts: ContentPart[] = [
    {
      type: "text",
      text: hint ? `Analyze this. Note from the user: ${hint}` : "Analyze this photo.",
    },
  ];
  if (imageDataUrl) {
    parts.push({ type: "image_url", image_url: { url: imageDataUrl } });
  }

  const content = await chat(apiKey, model, [
    { role: "system", content: system },
    { role: "user", content: parts },
  ]);

  const raw = extractJsonObject(content) as {
    kind?: unknown;
    title?: unknown;
    description?: unknown;
    confidence?: unknown;
    nutrients?: unknown;
    calories_burned?: unknown;
    duration_min?: unknown;
  };

  const title =
    typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : "Untitled";
  const description = typeof raw.description === "string" ? raw.description.trim() : "";
  const confidence =
    raw.confidence === "low" || raw.confidence === "medium" || raw.confidence === "high"
      ? raw.confidence
      : "low";

  if (raw.kind === "workout") {
    const cal =
      typeof raw.calories_burned === "string"
        ? parseFloat(raw.calories_burned)
        : raw.calories_burned;
    const dur =
      typeof raw.duration_min === "string" ? parseFloat(raw.duration_min) : raw.duration_min;
    return {
      kind: "workout",
      workout: {
        title: title === "Untitled" ? "Workout" : title,
        description,
        confidence,
        calories_burned:
          typeof cal === "number" && isFinite(cal) && cal >= 0 ? Math.round(cal) : 0,
        duration_min:
          typeof dur === "number" && isFinite(dur) && dur > 0 ? Math.round(dur) : null,
      },
    };
  }

  return {
    kind: "meal",
    meal: {
      title: title === "Untitled" ? "Meal" : title,
      description,
      confidence,
      nutrients: sanitizeNutrients(raw.nutrients),
    },
  };
}

export interface AnalyzeWorkoutOptions {
  apiKey: string;
  model: string;
  /** JPEG data URL of a workout-app screenshot. */
  imageDataUrl?: string;
  /** Optional user note, e.g. "45 min easy run". */
  hint?: string;
}

/**
 * Extract an exercise session from a workout-app screenshot (and/or note):
 * activity, duration, and calories burned (negative calories in the diary).
 */
export async function analyzeWorkout(opts: AnalyzeWorkoutOptions): Promise<WorkoutAnalysis> {
  const { apiKey, model, imageDataUrl, hint } = opts;
  if (!imageDataUrl && !hint) {
    throw new Error("Provide a screenshot or a description to analyze");
  }

  const system = [
    "You extract structured workout data from a screenshot of a fitness/workout app summary (or a text description).",
    "Respond with a SINGLE JSON object and nothing else - no markdown, no code fences.",
    "Schema:",
    `{"title": string (short activity name, e.g. "Morning run", max 5 words),`,
    `"description": string (1-2 sentences: activity, distance/pace/heart-rate details you can read),`,
    `"confidence": "low" | "medium" | "high",`,
    `"calories_burned": number (kcal, the active/total energy shown; estimate from activity + duration if not shown),`,
    `"duration_min": number | null (total minutes)}`,
    "Read the numbers exactly as displayed when visible; only estimate when missing.",
  ].join("\n");

  const parts: ContentPart[] = [
    {
      type: "text",
      text: hint
        ? `Extract this workout. Note from the user: ${hint}`
        : "Extract the workout from this screenshot.",
    },
  ];
  if (imageDataUrl) {
    parts.push({ type: "image_url", image_url: { url: imageDataUrl } });
  }

  const content = await chat(apiKey, model, [
    { role: "system", content: system },
    { role: "user", content: parts },
  ]);

  const raw = extractJsonObject(content) as {
    title?: unknown;
    description?: unknown;
    confidence?: unknown;
    calories_burned?: unknown;
    duration_min?: unknown;
  };

  const cal =
    typeof raw.calories_burned === "string"
      ? parseFloat(raw.calories_burned)
      : raw.calories_burned;
  const dur =
    typeof raw.duration_min === "string" ? parseFloat(raw.duration_min) : raw.duration_min;

  return {
    title:
      typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : "Workout",
    description: typeof raw.description === "string" ? raw.description.trim() : "",
    confidence:
      raw.confidence === "low" || raw.confidence === "medium" || raw.confidence === "high"
        ? raw.confidence
        : "low",
    calories_burned:
      typeof cal === "number" && isFinite(cal) && cal >= 0 ? Math.round(cal) : 0,
    duration_min:
      typeof dur === "number" && isFinite(dur) && dur > 0 ? Math.round(dur) : null,
  };
}

/**
 * Ask a model to estimate the nutrient contents of a supplement from its
 * name/label text (e.g. "Magnesium citrate 300 mg"). Used to prefill the
 * supplement editor.
 */
export async function analyzeSupplement(
  apiKey: string,
  model: string,
  labelText: string,
): Promise<{ nutrients: Nutrients; notes: string }> {
  const system = [
    "You convert a dietary supplement description into its nutrient contents per single dose.",
    "Respond with a SINGLE JSON object and nothing else - no markdown, no code fences.",
    `Schema: {"nutrients": {${nutrientKeyDoc()}}, "notes": string (brief; elemental amounts, assumptions)}`,
    "Use ELEMENTAL amounts for minerals (e.g. magnesium citrate 300mg is ~48mg elemental magnesium if 300mg refers to the compound; state your assumption in notes).",
    "Omit keys you cannot estimate.",
  ].join("\n");

  const content = await chat(apiKey, model, [
    { role: "system", content: system },
    { role: "user", content: `Supplement: ${labelText}` },
  ]);

  const raw = extractJsonObject(content) as { nutrients?: unknown; notes?: unknown };
  return {
    nutrients: sanitizeNutrients(raw.nutrients),
    notes: typeof raw.notes === "string" ? raw.notes : "",
  };
}
