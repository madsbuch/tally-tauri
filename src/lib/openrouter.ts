import { fetch } from "@tauri-apps/plugin-http";
import type { FoodAnalysis, Nutrients, ORModel, WorkoutAnalysis } from "./types";
import { NUTRIENT_DEFS } from "./nutrients";
import {
  FoodAnalysisSchema,
  PhotoAnalysisSchema,
  SupplementAnalysisSchema,
  WorkoutAnalysisSchema,
  parseChatResponse,
  parseJson,
  parseModelsResponse,
} from "./schemas";
import type { ChatMessage, ContentPart, ToolCall } from "./schemas";

export type { ChatMessage, ContentPart, ToolCall } from "./schemas";

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
  const models = parseModelsResponse(await res.json());
  if (models === null) {
    throw new OpenRouterError("Unexpected /models response shape", res.status);
  }
  return models;
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

// HTTP statuses worth retrying: timeout, too-early, rate limit, server/gateway.
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1_000;
const REQUEST_TIMEOUT_MS = 90_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Some providers return assistant content as an array of parts; flatten it. */
function contentToText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const text = content
      .map((p) =>
        p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string"
          ? (p as { text: string }).text
          : "",
      )
      .join("");
    return text.length > 0 ? text : null;
  }
  return null;
}

export interface ChatOptions {
  /**
   * Return an empty turn instead of retrying/failing when the model produces
   * an empty completion. Agent loops set this once something has already been
   * delivered/logged: models signal "I'm done" with an empty response, and
   * treating that as an error surfaces a bogus failure after a good answer.
   */
  allowEmpty?: boolean;
}

/**
 * POST /chat/completions with a per-request timeout and automatic retries
 * (exponential backoff) on network failures, retryable HTTP statuses,
 * per-choice provider errors embedded in HTTP 200 responses, and completely
 * empty completions — all of which providers produce transiently.
 */
async function requestChatTurn(
  apiKey: string,
  body: Record<string, unknown>,
  opts: ChatOptions = {},
): Promise<AssistantTurn> {
  let lastError: Error = new OpenRouterError("OpenRouter request failed", 0);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let res: Awaited<ReturnType<typeof fetch>>;
      try {
        res = await fetch(`${BASE}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            ...APP_HEADERS,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      const json = parseChatResponse(await res.json().catch(() => ({})));
      if (!res.ok || json.error) {
        const msg = json.error?.message ?? `HTTP ${res.status}`;
        const err = new OpenRouterError(`OpenRouter request failed: ${msg}`, res.status);
        if (!RETRYABLE_STATUS.has(res.status)) throw err;
        lastError = err;
        continue;
      }
      const choice = json.choices?.[0];
      if (!choice || choice.error || choice.finish_reason === "error") {
        lastError = new OpenRouterError(
          `Model error: ${choice?.error?.message ?? "provider returned an error"}`,
          res.status,
        );
        continue;
      }
      const content = contentToText(choice.message?.content);
      const tool_calls = choice.message?.tool_calls ?? [];
      if ((content == null || content.trim() === "") && tool_calls.length === 0) {
        if (opts.allowEmpty) return { content: null, tool_calls: [] };
        lastError = new OpenRouterError("Model returned an empty response", res.status);
        continue;
      }
      return { content, tool_calls };
    } catch (e) {
      // Non-retryable errors are OpenRouterErrors thrown above; anything else
      // is a network failure or timeout — retry.
      if (e instanceof OpenRouterError) throw e;
      lastError = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw lastError;
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
  opts: ChatOptions = {},
): Promise<AssistantTurn> {
  // Some providers reject an empty tools array — omit it instead.
  return requestChatTurn(
    apiKey,
    tools.length > 0 ? { model, messages, tools } : { model, messages },
    opts,
  );
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
  const { content } = await requestChatTurn(apiKey, { model, messages });
  if (content == null || content.trim() === "") {
    throw new OpenRouterError("Model returned an empty response", 0);
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
  return parseJson(text.slice(start, end + 1));
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

  return FoodAnalysisSchema.parse(extractJsonObject(content));
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

  return PhotoAnalysisSchema.parse(extractJsonObject(content));
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

  return WorkoutAnalysisSchema.parse(extractJsonObject(content));
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

  return SupplementAnalysisSchema.parse(extractJsonObject(content));
}
