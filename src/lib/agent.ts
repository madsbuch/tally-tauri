/**
 * Fire-and-forget diary agent.
 *
 * A capture (photo and/or note) is stored instantly and resolved in the
 * background: the model sees the current time, the supplement catalog and the
 * diary around this day, then records entries exclusively through tool calls
 * (log_meal / repeat_meal / log_workout / log_supplement), so phrases like
 * "ate this earlier today" get a concrete timestamp and "one more of those"
 * gets the same numbers as the first one. Successful captures are deleted;
 * failures stay visible in the timeline with a retry.
 */
import {
  addCapture,
  addFoodEntry,
  addSupplement,
  addSupplementLog,
  addWorkout,
  deleteCapture,
  deletePhotoIfUnused,
  getCapture,
  getFoodEntry,
  getSetting,
  listFoodEntriesForDay,
  listFoodEntriesForRange,
  listPendingCaptures,
  listSupplementLogsForDay,
  listSupplements,
  listWorkoutsForDay,
  setCaptureStatus,
  todayStr,
} from "./db";
import { chatWithTools } from "./openrouter";
import type { ChatMessage, ContentPart, ToolDef } from "./openrouter";
import { parseToolArgs } from "./schemas";
import { unlockAchievement } from "./achievements";
import { FOOD_FACTS_TOOL, executeFoodFactsSearch } from "./openFoodFacts";
import { NUTRIENT_DEFS, sanitizeNutrients, scaleNutrients } from "./nutrients";
import { iconKeys, isIconKey } from "./icons";
import { onAppResume, wasSuspendedSince } from "./appLifecycle";
import { withBackgroundTask } from "./background";
import { readPhotoDataUrl, savePhoto } from "./photos";
import { shiftDay, timeOf } from "./daystamp";
import type {
  Capture,
  FoodEntry,
  Supplement,
  SupplementLogWithSupplement,
  Workout,
} from "./types";
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
  'Local wall-clock time the item happened, as "HH:MM" (on the diary day) or "YYYY-MM-DD HH:MM". ' +
  "Times the user mentions are already in their local timezone — pass them through VERBATIM " +
  '("at 8am" → "08:00"); NEVER convert between timezones or to UTC, and never append "Z" or an offset. ' +
  "Resolve relative phrases yourself using the current local time given in the system prompt " +
  '("earlier today", "this morning" ≈ 08:00, "after lunch" ≈ 13:00). Never a future time.';

/**
 * The `icon` parameter: entries without a photo show this glyph in the
 * timeline, so a logged espresso gets ☕ instead of the generic 🍽. Kept as a
 * closed enum — an unknown value is dropped and the title-keyword guess in
 * lib/icons.ts takes over.
 */
function iconSchema(kind: "meal" | "workout"): Record<string, unknown> {
  return {
    type: "string",
    enum: iconKeys(kind),
    description:
      `Icon shown for this entry when it has no photo. Pick the most specific ` +
      `match for what was actually ${kind === "meal" ? "eaten or drunk" : "done"} ` +
      `(e.g. a cup of coffee → "coffee"); omit only if nothing fits.`,
  };
}

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
          icon: iconSchema("meal"),
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
          icon: iconSchema("workout"),
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
  {
    type: "function",
    function: {
      name: "repeat_meal",
      description:
        "Log another serving of something already in the diary — \"one more cheese cube\", " +
        "\"same coffee as this morning\", \"the usual breakfast\". Copies that entry's nutrients " +
        "exactly rather than estimating them again, so a thing eaten twice counts the same twice. " +
        "Use it whenever the note points back at an entry listed in your instructions; fall back " +
        "to log_meal only when nothing listed is what they mean.",
      parameters: {
        type: "object",
        properties: {
          id: {
            type: "number",
            description: "Entry id (the #number) from the diary listing in your instructions",
          },
          portion: {
            type: "number",
            description:
              "Multiple of that entry's portion: 1 (default) for the same again, 2 for twice as much, 0.5 for half.",
          },
          time: { type: "string", description: TIME_DESC },
        },
        required: ["id", "time"],
        additionalProperties: false,
      },
    },
  },
  FOOD_FACTS_TOOL,
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

/**
 * What the diary already holds around this capture.
 *
 * Without it the agent estimates every cheese cube from scratch, so the same
 * food logged twice in a day comes out at two different numbers — and "one
 * more of those" means nothing to it at all.
 */
interface DiaryContext {
  meals: FoodEntry[];
  workouts: Workout[];
  supplements: SupplementLogWithSupplement[];
  /**
   * Distinct things eaten on the days before — what "the usual" refers to
   * when the day being added to is still empty.
   */
  recentMeals: FoodEntry[];
}

const RECENT_DAYS = 7;
const MAX_RECENT = 10;

async function loadDiaryContext(day: string): Promise<DiaryContext> {
  const before = shiftDay(day, -RECENT_DAYS);
  const [meals, workouts, supplements, week] = await Promise.all([
    listFoodEntriesForDay(day).catch(() => []),
    listWorkoutsForDay(day).catch(() => []),
    listSupplementLogsForDay(day).catch(() => []),
    listFoodEntriesForRange(before, shiftDay(day, -1)).catch(() => []),
  ]);

  // One line per distinct food, newest first: a week of repeats would
  // otherwise crowd out everything else.
  const seen = new Set(meals.map((m) => m.title.toLowerCase()));
  const recentMeals: FoodEntry[] = [];
  for (const m of week) {
    const key = m.title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    recentMeals.push(m);
    if (recentMeals.length >= MAX_RECENT) break;
  }
  return { meals, workouts, supplements, recentMeals };
}

const kcalOf = (e: FoodEntry): number => Math.round(e.nutrients.calories ?? 0);

function renderDiaryContext(ctx: DiaryContext, day: string, isToday: boolean): string {
  const lines: string[] = [];
  const when = isToday ? "today" : day;

  if (ctx.meals.length + ctx.workouts.length + ctx.supplements.length === 0) {
    lines.push(`Already in the diary for ${when}: nothing yet.`);
  } else {
    lines.push(`Already in the diary for ${when}:`);
    for (const m of ctx.meals) {
      const p = m.nutrients.protein_g;
      lines.push(
        `  #${m.id} ${timeOf(m.eaten_at, m.tz_offset_min)} ate "${m.title}"` +
          ` — ${kcalOf(m)} kcal${p != null ? `, ${Math.round(p)}g protein` : ""}`,
      );
    }
    for (const w of ctx.workouts) {
      lines.push(
        `  ${timeOf(w.performed_at, w.tz_offset_min)} did "${w.title}"` +
          ` — ${Math.round(w.calories_burned)} kcal burned` +
          `${w.duration_min != null ? `, ${Math.round(w.duration_min)} min` : ""}`,
      );
    }
    for (const l of ctx.supplements) {
      lines.push(
        `  ${timeOf(l.taken_at, l.tz_offset_min)} took ${l.amount} × "${l.name}"`,
      );
    }
  }

  if (ctx.recentMeals.length > 0) {
    lines.push(
      `Eaten in the last week (for "the usual" when it isn't on the list above): ` +
        ctx.recentMeals
          .map((m) => `#${m.id} "${m.title}" ${kcalOf(m)} kcal`)
          .join(", "),
    );
  }
  return lines.join("\n");
}

function buildSystemPrompt(
  capture: Capture,
  catalog: Supplement[],
  diary: DiaryContext,
): string {
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
    "",
    renderDiaryContext(diary, capture.day, isToday),
    "",
    "Rules:",
    "- The listing above is what is ALREADY recorded. It is context, never a reason to skip logging: this capture is something new unless the note says otherwise.",
    "- When the note points back at one of those entries — \"one more cheese cube\", \"another coffee\", \"same as this morning\", \"the usual\" — call repeat_meal with that entry's id instead of estimating again. Two of the same thing should count the same both times.",
    "- Decide what the capture shows: food/drink → log_meal; exercise → log_workout; supplement intake → log_supplement.",
    "- Branded/packaged products (wrappers, bottles, cans, labels): look them up with search_packaged_food first and base the nutrients on the best match, scaled to the portion actually consumed. The database often lacks micronutrients — estimate missing keys yourself. Never search for home-cooked or generic foods; if the search fails or nothing matches, estimate everything yourself.",
    "- A capture may contain several items (e.g. a meal AND a supplement) — make one tool call per item.",
    "- All times are LOCAL to the user (timezone above). Explicit times in the note are already local wall-clock — repeat them verbatim, never convert to UTC or any other timezone. Relative phrases estimated; no time clue → current time. Never a future time.",
    "- For meals, estimate TOTAL nutrients for the visible portion; omit keys you cannot estimate.",
    "- Always pass `icon` on log_meal/log_workout: it is what the user sees in the timeline when there is no photo. Pick the most specific match (a cappuccino is \"coffee\", not \"meal\").",
    "- After your final tool call, reply with one short plain-text sentence of confirmation.",
    "- If there is nothing usable to record, call no tools and explain why in one plain-text sentence.",
  ].join("\n");
}

/**
 * "HH:MM" (on `day`) or "YYYY-MM-DD HH:MM" → UTC ISO, clamped to now.
 *
 * Bare times are LOCAL wall-clock. If the model disobeys and appends an
 * explicit timezone ("Z" or ±HH:MM), the offset is honored rather than
 * misread as local — that's how "8am" once became 09:00 in the diary.
 */
export function resolveAgentTime(raw: string | undefined, day: string): string {
  const now = new Date();
  let d: Date | null = null;
  if (typeof raw === "string") {
    const t = raw.trim();
    const zoned =
      /^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})$/i.exec(
        t,
      );
    if (zoned) {
      const [, zDate = "", zHour = "", zMin = "", zOff = ""] = zoned;
      const off =
        zOff.toUpperCase() === "Z"
          ? "Z"
          : zOff.includes(":")
            ? zOff
            : `${zOff.slice(0, 3)}:${zOff.slice(3)}`;
      const parsed = new Date(`${zDate}T${zHour.padStart(2, "0")}:${zMin}:00${off}`);
      if (!isNaN(parsed.getTime())) d = parsed;
    }
    const full = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})/.exec(t);
    const hm = /^(\d{1,2}):(\d{2})(?:\s*(am|pm))?$/i.exec(t);
    if (!d && full) {
      const [, fy = "", fm = "", fd = "", fh = "", fmin = ""] = full;
      d = new Date(+fy, +fm - 1, +fd, +fh, +fmin);
    } else if (!d && hm) {
      const [, hStr = "", minStr = "", ap] = hm;
      let hh = +hStr;
      const meridiem = ap?.toLowerCase();
      if (meridiem === "pm" && hh < 12) hh += 12;
      if (meridiem === "am" && hh === 12) hh = 0;
      const [y = 0, m = 1, dd = 1] = day.split("-").map(Number);
      d = new Date(y, m - 1, dd, hh, +minStr);
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

const round2 = (n: number): number => Math.round(n * 100) / 100;

function num(v: unknown): number | null {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return typeof n === "number" && isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** An icon key the model picked, or null when it made one up / skipped it. */
function icon(v: unknown): string | null {
  const key = str(v);
  return isIconKey(key) ? key : null;
}

async function executeTool(
  ctx: ToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  if (name === "search_packaged_food") {
    return executeFoodFactsSearch(args);
  }

  const time = resolveAgentTime(str(args["time"]) ?? undefined, ctx.capture.day);

  if (name === "log_meal") {
    const title = str(args["title"]) ?? "Meal";
    const photo = ctx.photoToAttach;
    ctx.photoToAttach = null;
    await addFoodEntry({
      eaten_at: time,
      title,
      description: str(args["description"]),
      photo_path: photo,
      nutrients: sanitizeNutrients(args["nutrients"]),
      model_id: ctx.model,
      icon: icon(args["icon"]),
    });
    ctx.logged++;
    // Event-only achievement: eaten-time within 10 min of the capture being
    // resolved means the meal was logged in the moment, not backfilled.
    if (Math.abs(Date.now() - new Date(time).getTime()) <= 10 * 60_000) {
      void unlockAchievement("quick_draw");
    }
    notifyDiaryChanged();
    return `Logged meal "${title}" at ${time}.`;
  }

  if (name === "repeat_meal") {
    const rawId = num(args["id"]);
    if (rawId == null) return "Error: id is required.";
    const source = await getFoodEntry(Math.round(rawId));
    if (!source) {
      return `Error: there is no diary entry #${Math.round(rawId)} — log it with log_meal instead.`;
    }
    // A portion is a multiple of what that entry was, so the bounds only have
    // to keep a nonsense number from turning into a nonsense day.
    const portion = Math.min(20, Math.max(0.05, num(args["portion"]) ?? 1));
    const title = portion === 1 ? source.title : `${source.title} (${round2(portion)}×)`;
    const photo = ctx.photoToAttach;
    ctx.photoToAttach = null;
    await addFoodEntry({
      eaten_at: time,
      title,
      description: source.description,
      photo_path: photo,
      nutrients: sanitizeNutrients(scaleNutrients(source.nutrients, portion)),
      // The numbers are the earlier entry's, not this model's guess.
      model_id: source.model_id,
      icon: source.icon,
    });
    ctx.logged++;
    notifyDiaryChanged();
    return `Logged "${title}" at ${time}, copied from #${source.id}.`;
  }

  if (name === "log_workout") {
    const title = str(args["title"]) ?? "Workout";
    const cal = num(args["calories_burned"]);
    const dur = num(args["duration_min"]);
    const photo = ctx.photoToAttach;
    ctx.photoToAttach = null;
    await addWorkout({
      performed_at: time,
      title,
      description: str(args["description"]),
      photo_path: photo,
      calories_burned: cal != null && cal >= 0 ? Math.round(cal) : 0,
      duration_min: dur != null && dur > 0 ? Math.round(dur) : null,
      model_id: ctx.model,
      icon: icon(args["icon"]),
    });
    ctx.logged++;
    notifyDiaryChanged();
    return `Logged workout "${title}" at ${time}.`;
  }

  if (name === "log_supplement") {
    const name_ = str(args["name"]);
    if (!name_) return "Error: supplement name is required.";
    const amount = Math.max(0.5, num(args["amount"]) ?? 1);
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

const MAX_ROUNDS = 10;
const inFlight = new Set<number>();

// ---------------------------------------------------------------------------
// Background awareness
// ---------------------------------------------------------------------------

/**
 * Re-run captures the OS interrupted whenever the app returns to the
 * foreground (see lib/appLifecycle.ts for why that happens). Call once on app
 * start; returns a cleanup function.
 */
export function installCaptureLifecycle(): () => void {
  return onAppResume(() => void resumePendingCaptures());
}

async function runCapture(capture: Capture): Promise<void> {
  const apiKey = await getSetting(SETTING_KEYS.openrouterApiKey);
  if (!apiKey) {
    throw new Error("Add your OpenRouter API key in Settings first");
  }
  const model = (await getSetting(SETTING_KEYS.visionModel)) || DEFAULT_VISION_MODEL;
  const [catalog, diary] = await Promise.all([
    listSupplements(),
    loadDiaryContext(capture.day),
  ]);

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
    { role: "system", content: buildSystemPrompt(capture, catalog, diary) },
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
  let dissolved = false;
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
        const args = parseToolArgs(call.function.arguments);
        result = await executeTool(ctx, call.function.name, args);
      } catch (e) {
        result = `Error: ${e instanceof Error ? e.message : String(e)}`;
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
    // Dissolve the capture into its entries the instant the first item is
    // recorded — not at the end of the run. If the app is then killed or a
    // later round's request is dropped (both common when backgrounded on
    // mobile), there's no half-logged capture left in "pending" for the next
    // resume to re-run, which would re-log everything already recorded here.
    if (ctx.logged > 0 && !dissolved) {
      dissolved = true;
      await deleteCapture(capture.id);
      notifyDiaryChanged();
    }
  }

  if (ctx.logged === 0) {
    throw new Error(lastText?.trim() || "The model didn't record anything.");
  }

  // Event-only achievement: captures dissolve on success, so a multi-item
  // resolution can only be detected here.
  if (ctx.logged >= 3) void unlockAchievement("combo_capture");

  // The capture already dissolved above (ctx.logged > 0 is guaranteed here).
  if (ctx.photoToAttach) {
    // Nothing took the photo (e.g. only a supplement was logged). Guard anyway
    // in case a produced entry happens to share the filename.
    await deletePhotoIfUnused(ctx.photoToAttach);
  }
  notifyDiaryChanged();
}

async function processCapture(id: number): Promise<void> {
  if (inFlight.has(id)) return;
  inFlight.add(id);
  const startedAt = Date.now();
  try {
    const capture = await getCapture(id);
    if (!capture) return;
    try {
      // Held open so the analysis finishes even if the user locks the phone
      // the moment after snapping the photo.
      await withBackgroundTask("Analyzing your capture", () => runCapture(capture));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // If the app was suspended (backgrounded) at any point during this run,
      // the failure is almost certainly the OS dropping our in-flight request
      // rather than a real problem. Keep the capture "pending" so it retries
      // when the app returns to the foreground, instead of surfacing a bogus
      // error the user has to dismiss and re-run by hand.
      if (wasSuspendedSince(startedAt)) {
        await setCaptureStatus(id, "pending", null);
      } else {
        await setCaptureStatus(id, "error", msg);
      }
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
  photoBase64?: string | undefined;
  note?: string | undefined;
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

/**
 * Delete a capture without logging anything. Its photo is removed only if no
 * entry produced from this capture (before it was discarded) still references
 * the file — discarding a capture that already made entries must not take their
 * shared photo with it.
 */
export async function discardCapture(capture: Capture): Promise<void> {
  await deleteCapture(capture.id);
  await deletePhotoIfUnused(capture.photo_path);
  notifyDiaryChanged();
}

/** Resume captures that were interrupted (call once on app start). */
export async function resumePendingCaptures(): Promise<void> {
  const pending = await listPendingCaptures();
  for (const c of pending) {
    void processCapture(c.id);
  }
}
