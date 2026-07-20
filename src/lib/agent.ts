/**
 * Fire-and-forget diary agent.
 *
 * A capture (photo and/or note) is stored instantly and resolved in the
 * background: the model sees the current time and the supplement catalog and
 * records entries exclusively through tool calls (log_meal / log_workout /
 * log_supplement), so phrases like "ate this earlier today" get a concrete
 * timestamp chosen by the model. Successful captures are deleted; failures
 * stay visible in the timeline with a retry.
 */
import {
  addCapture,
  addFoodEntry,
  addSupplement,
  addSupplementLog,
  addWorkout,
  deleteCapture,
  getCapture,
  getSetting,
  listPendingCaptures,
  listSupplements,
  setCaptureStatus,
  todayStr,
} from "./db";
import { chatWithTools } from "./openrouter";
import type { ChatMessage, ContentPart, ToolDef } from "./openrouter";
import { NUTRIENT_DEFS, sanitizeNutrients } from "./nutrients";
import { deletePhoto, readPhotoDataUrl, savePhoto } from "./photos";
import type { Capture, Supplement } from "./types";
import { DEFAULT_VISION_MODEL, SETTING_KEYS } from "./types";

// ---------------------------------------------------------------------------
// Change notifications (DiaryPage refreshes on these)
// ---------------------------------------------------------------------------

export const DIARY_CHANGED_EVENT = "tally:diary-changed";

export function notifyDiaryChanged(): void {
  window.dispatchEvent(new CustomEvent(DIARY_CHANGED_EVENT));
}

export function onDiaryChanged(handler: () => void): () => void {
  window.addEventListener(DIARY_CHANGED_EVENT, handler);
  return () => window.removeEventListener(DIARY_CHANGED_EVENT, handler);
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const TIME_DESC =
  'Local time the item happened, as "HH:MM" (on the diary day) or "YYYY-MM-DD HH:MM". ' +
  "Resolve relative phrases yourself using the current time given in the system prompt " +
  '("earlier today", "this morning" ≈ 08:00, "after lunch" ≈ 13:00). Never a future time.';

function nutrientsSchema(): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const d of NUTRIENT_DEFS) {
    props[d.key] = { type: "number", description: `${d.label} in ${d.unit}` };
  }
  return {
    type: "object",
    description:
      "Estimated TOTAL amounts for the whole portion. Include every key you can reasonably estimate; omit the rest.",
    properties: props,
    additionalProperties: false,
  };
}

const DIARY_TOOLS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "log_meal",
      description:
        "Record food or drink that was eaten. Estimate nutrition like a meticulous nutritionist.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short meal name, max 5 words" },
          description: {
            type: "string",
            description: "1-2 sentences: what it is and portion-size assumptions",
          },
          time: { type: "string", description: TIME_DESC },
          confidence: { type: "string", enum: ["low", "medium", "high"] },
          nutrients: nutrientsSchema(),
        },
        required: ["title", "time"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "log_workout",
      description:
        "Record an exercise session (from a workout-app screenshot, watch/machine display, or description). Burned calories are subtracted from the day's total.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short activity name, max 5 words" },
          description: {
            type: "string",
            description: "1-2 sentences: activity plus distance/pace/HR details you can read",
          },
          time: { type: "string", description: TIME_DESC },
          confidence: { type: "string", enum: ["low", "medium", "high"] },
          calories_burned: {
            type: "number",
            description: "kcal; read exactly when shown, estimate from activity + duration otherwise",
          },
          duration_min: { type: "number", description: "Total minutes, if known" },
        },
        required: ["title", "time", "calories_burned"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "log_supplement",
      description:
        "Record taking a dose of a supplement. Use a catalog name when it matches (case-insensitive); unknown names create a new catalog entry automatically.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Supplement name, e.g. 'Magnesium citrate'" },
          amount: { type: "number", description: "Number of doses taken (default 1)" },
          time: { type: "string", description: TIME_DESC },
        },
        required: ["name", "time"],
        additionalProperties: false,
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Prompt & time resolution
// ---------------------------------------------------------------------------

function tzOffsetLabel(d: Date): string {
  const mins = -d.getTimezoneOffset();
  const sign = mins >= 0 ? "+" : "-";
  const abs = Math.abs(mins);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

function buildSystemPrompt(capture: Capture, catalog: Supplement[]): string {
  const now = new Date();
  const weekday = now.toLocaleDateString("en-US", { weekday: "long" });
  const local = `${todayStr(now)} ${String(now.getHours()).padStart(2, "0")}:${String(
    now.getMinutes(),
  ).padStart(2, "0")}`;
  const isToday = capture.day === todayStr();
  const catalogTxt =
    catalog.length === 0
      ? "none yet"
      : catalog
          .map(
            (s) =>
              `"${s.name}"${s.dose_amount != null ? ` (1 dose = ${s.dose_amount}${s.dose_unit ? ` ${s.dose_unit}` : ""})` : ""}`,
          )
          .join(", ");

  return [
    "You are Tally's diary agent. The user captured a photo and/or a short note; record what happened using ONLY the provided tools.",
    `Current local date & time: ${weekday} ${local} (${tzOffsetLabel(now)}).`,
    `Diary day being added to: ${capture.day}${isToday ? " (today)" : " (a past day — with no time clue, use 12:00)"}.`,
    `Supplement catalog: ${catalogTxt}.`,
    "Rules:",
    "- Decide what the capture shows: food/drink → log_meal; exercise → log_workout; supplement intake → log_supplement.",
    "- A capture may contain several items (e.g. a meal AND a supplement) — make one tool call per item.",
    "- Resolve all times yourself in local time; explicit times verbatim, relative phrases estimated, default to the current time. Never a future time.",
    "- For meals, estimate TOTAL nutrients for the visible portion; omit keys you cannot estimate.",
    "- After your final tool call, reply with one short plain-text sentence of confirmation.",
    "- If there is nothing usable to record, call no tools and explain why in one plain-text sentence.",
  ].join("\n");
}

/** "HH:MM" (on `day`) or "YYYY-MM-DD HH:MM" → UTC ISO, clamped to now. */
export function resolveAgentTime(raw: string | undefined, day: string): string {
  const now = new Date();
  let d: Date | null = null;
  if (typeof raw === "string") {
    const t = raw.trim();
    const full = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})/.exec(t);
    const hm = /^(\d{1,2}):(\d{2})$/.exec(t);
    if (full) {
      d = new Date(+full[1], +full[2] - 1, +full[3], +full[4], +full[5]);
    } else if (hm) {
      const [y, m, dd] = day.split("-").map(Number);
      d = new Date(y, m - 1, dd, +hm[1], +hm[2]);
    }
  }
  if (!d || isNaN(d.getTime())) d = now;
  if (d.getTime() > now.getTime()) d = now;
  return d.toISOString();
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

interface ToolContext {
  capture: Capture;
  model: string;
  /** Photo filename not yet attached to an entry (attach once, first taker). */
  photoToAttach: string | null;
  logged: number;
}

function num(v: unknown): number | null {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return typeof n === "number" && isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

async function executeTool(
  ctx: ToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const time = resolveAgentTime(str(args.time) ?? undefined, ctx.capture.day);

  if (name === "log_meal") {
    const title = str(args.title) ?? "Meal";
    const photo = ctx.photoToAttach;
    ctx.photoToAttach = null;
    await addFoodEntry({
      eaten_at: time,
      title,
      description: str(args.description),
      photo_path: photo,
      nutrients: sanitizeNutrients(args.nutrients),
      model_id: ctx.model,
    });
    ctx.logged++;
    notifyDiaryChanged();
    return `Logged meal "${title}" at ${time}.`;
  }

  if (name === "log_workout") {
    const title = str(args.title) ?? "Workout";
    const cal = num(args.calories_burned);
    const dur = num(args.duration_min);
    const photo = ctx.photoToAttach;
    ctx.photoToAttach = null;
    await addWorkout({
      performed_at: time,
      title,
      description: str(args.description),
      photo_path: photo,
      calories_burned: cal != null && cal >= 0 ? Math.round(cal) : 0,
      duration_min: dur != null && dur > 0 ? Math.round(dur) : null,
      model_id: ctx.model,
    });
    ctx.logged++;
    notifyDiaryChanged();
    return `Logged workout "${title}" at ${time}.`;
  }

  if (name === "log_supplement") {
    const name_ = str(args.name);
    if (!name_) return "Error: supplement name is required.";
    const amount = Math.max(0.5, num(args.amount) ?? 1);
    const catalog = await listSupplements(true);
    let supp = catalog.find((s) => s.name.toLowerCase() === name_.toLowerCase());
    if (!supp) {
      const id = await addSupplement({
        name: name_,
        dose_amount: null,
        dose_unit: null,
        nutrients: {},
        notes: null,
        archived: 0,
      });
      supp = { id, name: name_, dose_amount: null, dose_unit: null, nutrients: {}, notes: null, archived: 0 };
    }
    await addSupplementLog(supp.id, amount, time);
    ctx.logged++;
    notifyDiaryChanged();
    return `Logged ${amount} × "${supp.name}" at ${time}.`;
  }

  return `Error: unknown tool "${name}".`;
}

// ---------------------------------------------------------------------------
// The capture loop
// ---------------------------------------------------------------------------

const MAX_ROUNDS = 6;
const inFlight = new Set<number>();

async function runCapture(capture: Capture): Promise<void> {
  const apiKey = await getSetting(SETTING_KEYS.openrouterApiKey);
  if (!apiKey) {
    throw new Error("Add your OpenRouter API key in Settings first");
  }
  const model = (await getSetting(SETTING_KEYS.visionModel)) || DEFAULT_VISION_MODEL;
  const catalog = await listSupplements();

  const parts: ContentPart[] = [
    {
      type: "text",
      text: capture.note?.trim()
        ? `Note from the user: ${capture.note.trim()}`
        : "No note — go by the photo.",
    },
  ];
  if (capture.photo_path) {
    // Read the stored photo through Rust — WebView fetch of the asset URL
    // is CSP-blocked on Android.
    const dataUrl = await readPhotoDataUrl(capture.photo_path);
    parts.push({ type: "image_url", image_url: { url: dataUrl } });
  }

  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(capture, catalog) },
    { role: "user", content: parts },
  ];

  const ctx: ToolContext = {
    capture,
    model,
    photoToAttach: capture.photo_path,
    logged: 0,
  };

  let lastText: string | null = null;
  let nudged = false;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    // Once something is logged, an empty completion just means "done" — it
    // must not fail the capture (retrying would log the items twice).
    const turn = await chatWithTools(apiKey, model, messages, DIARY_TOOLS, {
      allowEmpty: ctx.logged > 0,
    });
    if (turn.content?.trim()) lastText = turn.content.trim();
    if (turn.tool_calls.length === 0) {
      // Text-only reply with nothing logged yet: vision models occasionally
      // describe the meal in prose instead of calling log_meal. Push back
      // once before treating it as a failure.
      if (ctx.logged === 0 && !nudged) {
        nudged = true;
        messages.push({ role: "assistant", content: turn.content ?? "" });
        messages.push({
          role: "user",
          content:
            "Nothing has been recorded yet. If the capture shows any food, drink, " +
            "exercise, or supplement, record it NOW by calling the matching tool " +
            "(log_meal / log_workout / log_supplement) — a rough estimate is better " +
            "than nothing. Only reply in plain text if there is truly nothing to " +
            "record, and say why.",
        });
        continue;
      }
      break;
    }
    messages.push({
      role: "assistant",
      content: turn.content,
      tool_calls: turn.tool_calls,
    });
    for (const call of turn.tool_calls) {
      let result: string;
      try {
        const args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
        result = await executeTool(ctx, call.function.name, args);
      } catch (e) {
        result = `Error: ${e instanceof Error ? e.message : String(e)}`;
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
  }

  if (ctx.logged === 0) {
    throw new Error(lastText?.trim() || "The model didn't record anything.");
  }

  // Success: the capture dissolves into the entries it produced.
  await deleteCapture(capture.id);
  if (ctx.photoToAttach) {
    // Nothing took the photo (e.g. only a supplement was logged).
    await deletePhoto(ctx.photoToAttach);
  }
  notifyDiaryChanged();
}

async function processCapture(id: number): Promise<void> {
  if (inFlight.has(id)) return;
  inFlight.add(id);
  try {
    const capture = await getCapture(id);
    if (!capture) return;
    try {
      await runCapture(capture);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await setCaptureStatus(id, "error", msg);
      notifyDiaryChanged();
    }
  } finally {
    inFlight.delete(id);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface EnqueueOptions {
  /** Base64 JPEG payload (from compressImage), if a photo was taken. */
  photoBase64?: string;
  note?: string;
  /** Local diary day the user is viewing. */
  day: string;
}

/**
 * Fire-and-forget: persists the capture immediately and starts background
 * analysis. Returns as soon as the capture is stored — never blocks on AI.
 */
export async function enqueueCapture(opts: EnqueueOptions): Promise<number> {
  const photoPath = opts.photoBase64 ? await savePhoto(opts.photoBase64) : null;
  const id = await addCapture({
    created_at: new Date().toISOString(),
    day: opts.day,
    note: opts.note?.trim() || null,
    photo_path: photoPath,
  });
  notifyDiaryChanged();
  void processCapture(id);
  return id;
}

/** Re-run a failed capture. */
export async function retryCapture(id: number): Promise<void> {
  await setCaptureStatus(id, "pending", null);
  notifyDiaryChanged();
  void processCapture(id);
}

/** Delete a capture (and its photo) without logging anything. */
export async function discardCapture(capture: Capture): Promise<void> {
  await deleteCapture(capture.id);
  if (capture.photo_path) await deletePhoto(capture.photo_path);
  notifyDiaryChanged();
}

/** Resume captures that were interrupted (call once on app start). */
export async function resumePendingCaptures(): Promise<void> {
  const pending = await listPendingCaptures();
  for (const c of pending) {
    void processCapture(c.id);
  }
}
