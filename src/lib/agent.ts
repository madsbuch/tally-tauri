/**
 * Fire-and-forget diary agent.
 *
 * A capture (photo and/or note) is stored instantly and resolved in the
 * background: the model sees the current time, the supplement catalog and the
 * diary around this day, then records entries exclusively through tool calls
 * (log_meal / repeat_meal / log_workout / log_supplement / log_state /
 * add_rule / log_rule), so phrases like
 * "ate this earlier today" get a concrete timestamp and "one more of those"
 * gets the same numbers as the first one. Successful captures are deleted;
 * failures stay visible in the timeline with a retry.
 */
import {
  addCapture,
  addFoodEntry,
  addLifeRule,
  addLifeRuleLog,
  addStateLog,
  addSupplement,
  addSupplementLog,
  addWorkout,
  deleteCapture,
  deletePhotoIfUnused,
  findLifeRuleByText,
  getCapture,
  getLifeRule,
  getFoodEntry,
  getSetting,
  listFoodEntriesForDay,
  listFoodEntriesForRange,
  listLifeRules,
  listPendingCaptures,
  listStateCategories,
  listSupplementLogsForDay,
  listSupplements,
  listWorkoutsForDay,
  setCaptureStatus,
  todayStr,
  updateLifeRule,
} from "./db";
import { chatWithTools } from "./openrouter";
import type { ChatMessage, ContentPart, ToolDef } from "./openrouter";
import { parseLabelArgs, parseToolArgs } from "./schemas";
import { unlockAchievement } from "./achievements";
import {
  FOOD_FACTS_TOOL,
  executeFoodFactsSearch,
  foodRegion,
  labelPortion,
  regionLabel,
} from "./openFoodFacts";
import { NUTRIENT_DEFS, sanitizeNutrients } from "./nutrients";
import { iconKeys, isIconKey } from "./icons";
import { stateKey } from "./states";
import { clampBelief, isActedOn } from "./lifeRules";
import { onAppResume, wasSuspendedSince } from "./appLifecycle";
import { withBackgroundTask } from "./background";
import { readPhotoDataUrl, savePhoto } from "./photos";
import { dayOf, formatTime, shiftDay, timeOf } from "./daystamp";
import type {
  Capture,
  FoodEntry,
  LifeRule,
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

/** What a rule coming up is recorded with; shared by add_rule and log_rule. */
const RULE_MOMENT_PROPS: Record<string, unknown> = {
  situation: {
    type: "string",
    description:
      "What was going on when it came up, in their words. Omit when the note only states the rule.",
  },
  belief: {
    type: "number",
    description:
      "0-100: how much they believed it in that moment. ONLY when they gave a rating " +
      "(\"80%\", \"half-believe it\" ≈ 50); never guess one.",
  },
  acted_on: {
    type: "string",
    enum: ["yes", "partly", "no"],
    description:
      "Whether they did what the rule said. Only when the note says so.",
  },
  time: { type: "string", description: TIME_DESC },
};

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
          label: {
            type: "object",
            description:
              "Set when a search_packaged_food result is what was eaten: Tally then works out the " +
              "label's nutrients for the amount itself. Pass the barcode and ONE amount. Label " +
              "values replace yours for every key the label has, so `nutrients` only needs what " +
              "labels lack (usually the micronutrients).",
            properties: {
              barcode: {
                type: "string",
                description: "The product's barcode from search_packaged_food, digits only",
              },
              grams: {
                type: "number",
                description: "Amount consumed in g (in ml for drinks measured per 100 ml)",
              },
              servings: {
                type: "number",
                description: "Number of label servings consumed (needs a serving_size in the result)",
              },
              packages: {
                type: "number",
                description: "Number of whole packages consumed, e.g. 1 can, 0.5 of a bag",
              },
            },
            required: ["barcode"],
            additionalProperties: false,
          },
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
      name: "log_state",
      description:
        "Record how they FEEL — a symptom, a mood, a state of body or mind: \"bloated\", " +
        "\"depressive thoughts since this morning\", \"headache\", \"wired and can't sleep\". " +
        "Nothing was eaten or done here, so nothing is estimated: this is the note itself, " +
        "kept with a time so it can be read next to the day's food and sleep later. " +
        "Use one call per distinct state (tired AND bloated is two calls).",
      parameters: {
        type: "object",
        properties: {
          label: {
            type: "string",
            description:
              "What it is, in 1-3 words, as they'd say it: \"Bloated\", \"Depressive thoughts\".",
          },
          note: {
            type: "string",
            description:
              "Anything else they said about it — how bad, how long, what it followed. Their words, not yours.",
          },
          time: { type: "string", description: TIME_DESC },
        },
        required: ["label", "time"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "repeat_meal",
      description:
        "Log the exact same thing again — \"yet another beer\", \"one more cheese cube\", " +
        "\"same coffee as this morning\", \"the usual breakfast\". Copies an entry listed in your " +
        "instructions as it is, nutrients and all, so a thing had twice counts the same twice. " +
        "One call per serving: \"two more beers\" is two calls. Only for a plain repeat of the same " +
        "item in the same amount — when the amount differs (\"500 g skyr\" with \"Skyr 200 g\" " +
        "listed), or you can't tell it is the same product, use log_meal and estimate it afresh.",
      parameters: {
        type: "object",
        properties: {
          id: {
            type: "number",
            description: "Entry id (the #number) from the diary listing in your instructions",
          },
          time: { type: "string", description: TIME_DESC },
        },
        required: ["id", "time"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_rule",
      description:
        "Write down a RULE FOR LIVING (\"leveregel\"): a standing belief about how they must be " +
        "or what they are — \"I must always do things perfectly\", \"I'm a man, so I'm dangerous\", " +
        "\"if I rest, I'm lazy\". Not a passing feeling (that is log_state): a rule is general and " +
        "they live by it. If the rule is already on their list, use log_rule instead. " +
        "Pass `situation` when the note also says when or why it came up, so that moment is logged too.",
      parameters: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description:
              "The rule in THEIR exact words, copied from the note character for character — same " +
              "language, same wording. Never translate, shorten, soften, correct or rephrase it. " +
              "Drop only a lead-in like \"new rule:\" / \"ny leveregel:\".",
          },
          explicit: {
            type: "boolean",
            description:
              "true when they SAID this is a rule (\"new rule: …\", \"ny leveregel: …\", \"a rule I " +
              "have is …\"). false when you recognised a rule in what they wrote without them calling " +
              "it one — it is then saved as a suggestion they confirm or dismiss.",
          },
          ...RULE_MOMENT_PROPS,
        },
        required: ["text", "explicit", "time"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "log_rule",
      description:
        "Record that one of their rules for living (listed by #id in your instructions) came up: " +
        "it showed up in a situation, they caught themselves following it, or they pushed against it.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "number", description: "Rule id (the #number) from your instructions" },
          ...RULE_MOMENT_PROPS,
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
  /** Their rules for living, suggestions included, archived ones not. */
  rules: LifeRule[];
}

const RECENT_DAYS = 7;
const MAX_RECENT = 10;

async function loadDiaryContext(day: string): Promise<DiaryContext> {
  const before = shiftDay(day, -RECENT_DAYS);
  const [meals, workouts, supplements, week, allRules] = await Promise.all([
    listFoodEntriesForDay(day).catch(() => []),
    listWorkoutsForDay(day).catch(() => []),
    listSupplementLogsForDay(day).catch(() => []),
    listFoodEntriesForRange(before, shiftDay(day, -1)).catch(() => []),
    listLifeRules().catch(() => [] as LifeRule[]),
  ]);
  const rules = allRules.filter((r) => r.status !== "archived");

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
  return { meals, workouts, supplements, recentMeals, rules };
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

  if (ctx.rules.length === 0) {
    lines.push("Rules for living they have written down: none yet.");
  } else {
    lines.push("Rules for living they have written down (for log_rule):");
    for (const r of ctx.rules) {
      lines.push(`  #${r.id} "${r.text}"${r.status === "suggested" ? " (suggested, not confirmed yet)" : ""}`);
    }
  }
  return lines.join("\n");
}

function buildSystemPrompt(
  capture: Capture,
  catalog: Supplement[],
  diary: DiaryContext,
  /** Country product searches favour; null = worldwide. */
  foodCountry: string | null,
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
    "- When the note plainly means one of those entries again, the same thing in the same amount — \"yet another beer\", \"one more cheese cube\", \"same as this morning\", \"the usual\" — call repeat_meal with that entry's id (once per serving) instead of estimating again. Two of the same thing should count the same both times. A different amount, or a food that only shares a name with a listed one, is a new log_meal.",
    "- Decide what the capture shows: food/drink → log_meal; exercise → log_workout; supplement intake → log_supplement; how they FEEL (a symptom, a mood, a state — \"bloated\", \"low all afternoon\", \"headache\") → log_state; a RULE FOR LIVING → add_rule / log_rule (below).",
    "- Rules for living (\"leveregler\") are standing beliefs about how they must be or what they are: \"I must always…\", \"I'm X, so I'm Y\", \"if I…, then…\". When the note points at one already listed above (same idea, even in other words) → log_rule with its #id. When they declare a new one (\"new rule: …\", \"ny leveregel: …\") → add_rule with explicit=true. When they state a rule-shaped belief that isn't listed and didn't call it a rule → add_rule with explicit=false (it becomes a suggestion they confirm). A feeling about one moment (\"felt useless today\") is a state, not a rule; when unsure, use log_state.",
    "- A rule's text is THEIR words, copied verbatim in the language they wrote it in. Never translate, tidy, soften or rephrase it. Don't argue with a rule, reassure them about it or comment on it in your confirmation — only say what was recorded.",
    `- Branded/packaged products (wrappers, bottles, cans, labels, barcodes): look them up with search_packaged_food first — by the barcode digits when the photo shows them legibly, else by the name as printed on the package. ${foodCountry == null ? "" : `Searches cover products sold in ${foodCountry} first, then worldwide; prefer a match sold in their country. `}When a result is what was eaten, call log_meal with \`label\` (its barcode plus grams, servings or packages) and let Tally do the label arithmetic; put in \`nutrients\` only what the label lacks (usually the micronutrients). Never search for home-cooked or generic foods; if the search fails or nothing matches, estimate everything yourself and log without \`label\`.`,
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

/** How a repeated meal's description says where its numbers came from. */
const FROM_EARLIER_ENTRY = "Nutrition from an earlier entry:";

function num(v: unknown): number | null {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return typeof n === "number" && isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * "Thu 8 Oct, 08:12": when an entry was eaten, as the clock read where it was
 * eaten. A date rather than "this morning", since it is written down for good.
 */
function eatenWhen(e: FoodEntry): string {
  const [y = 0, m = 1, d = 1] = (e.day ?? dayOf(e.eaten_at, e.tz_offset_min))
    .split("-")
    .map(Number);
  const date = new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
  return `${date}, ${formatTime(e.eaten_at, e.tz_offset_min)}`;
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
    let nutrients = sanitizeNutrients(args["nutrients"]);
    let description = str(args["description"]);
    let fromLabel = "";
    const label = parseLabelArgs(args["label"]);
    if (label) {
      // Resolved before anything is written: a label that doesn't add up goes
      // back to the model to fix, rather than its guess going in under a
      // label's name.
      const portion = await labelPortion(label);
      // The label wins wherever it has a number; the model's estimate only
      // fills in what labels don't carry.
      nutrients = { ...nutrients, ...portion.nutrients };
      // Said in the entry itself, so the number can always be traced back.
      const source =
        `Nutrition from the label: ${portion.amount} ${portion.unit} of ${portion.product} ` +
        `(Open Food Facts ${portion.barcode}).`;
      description = description ? `${description} ${source}` : source;
      fromLabel =
        ` with label values for ${portion.amount} ${portion.unit}` +
        ` (${Math.round(portion.nutrients.calories ?? 0)} kcal)`;
    }
    const photo = ctx.photoToAttach;
    ctx.photoToAttach = null;
    await addFoodEntry({
      eaten_at: time,
      title,
      description,
      photo_path: photo,
      nutrients,
      model_id: ctx.model,
      icon: icon(args["icon"]),
    });
    ctx.logged++;
    // Event-only achievement: a meal photographed within 10 min of when it
    // was eaten — logged in the moment, not backfilled. Measured against when
    // the capture was taken, not when the agent got round to it, and only for
    // photos: a bare note with no time in it resolves to "now" and would hand
    // this out for every text capture.
    if (
      ctx.capture.photo_path &&
      Math.abs(new Date(ctx.capture.created_at).getTime() - new Date(time).getTime()) <=
        10 * 60_000
    ) {
      void unlockAchievement("quick_draw");
    }
    notifyDiaryChanged();
    return `Logged meal "${title}" at ${time}${fromLabel}.`;
  }

  if (name === "repeat_meal") {
    const rawId = num(args["id"]);
    if (rawId == null) return "Error: id is required.";
    const source = await getFoodEntry(Math.round(rawId));
    if (!source) {
      return `Error: there is no diary entry #${Math.round(rawId)} — log it with log_meal instead.`;
    }
    // A copy is the same thing again, never a scaled one: 2.5 × "Skyr 200 g"
    // is a guess that it was the same skyr, dressed up as a fact. A different
    // amount gets estimated afresh.
    //
    // Said in the entry itself, as a label's numbers are, so a copy can always
    // be traced back. A copy of a copy already names the entry its numbers
    // first came from, which is still where they came from — "yet another
    // beer" shouldn't grow a sentence per round.
    const description = source.description?.includes(FROM_EARLIER_ENTRY)
      ? source.description
      : [source.description, `${FROM_EARLIER_ENTRY} "${source.title}" (${eatenWhen(source)}).`]
          .filter(Boolean)
          .join(" ");
    const photo = ctx.photoToAttach;
    ctx.photoToAttach = null;
    await addFoodEntry({
      eaten_at: time,
      title: source.title,
      description,
      photo_path: photo,
      nutrients: source.nutrients,
      // The numbers are the earlier entry's, not this model's guess.
      model_id: source.model_id,
      icon: source.icon,
    });
    ctx.logged++;
    notifyDiaryChanged();
    return `Logged "${source.title}" at ${time}, copied from #${source.id}.`;
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

  if (name === "log_state") {
    const label = str(args["label"]);
    if (!label) return "Error: label is required.";
    // The emoji belongs to the category when they keep one for this; a state
    // the agent hears about that isn't on their list is logged all the same,
    // just without one. Their list stays theirs to add to.
    const known = (await listStateCategories()).find(
      (c) => stateKey(c.label) === stateKey(label),
    );
    await addStateLog({
      label: known?.label ?? label,
      icon: known?.icon ?? null,
      note: str(args["note"]) || null,
      loggedAt: time,
    });
    ctx.logged++;
    notifyDiaryChanged();
    return `Logged "${label}" at ${time}.`;
  }

  if (name === "add_rule" || name === "log_rule") {
    const situation = str(args["situation"]);
    const belief = clampBelief(args["belief"]);
    const acted = args["acted_on"];
    const actedOn = isActedOn(acted) ? acted : null;

    let rule: LifeRule | null;
    let isNew = false;
    if (name === "log_rule") {
      const id = num(args["id"]);
      rule = id === null ? null : await getLifeRule(id);
      if (!rule) return `Error: no rule #${args["id"]}. Use an id from your instructions, or add_rule.`;
    } else {
      const text = str(args["text"]);
      if (!text) return "Error: text is required.";
      const explicit = args["explicit"] === true;
      rule = await findLifeRuleByText(text);
      if (rule) {
        // Said again in so many words: a rule they had put away is back, and
        // one they now call a rule is no longer just our suggestion.
        if (rule.status === "archived" || (explicit && rule.status === "suggested")) {
          await updateLifeRule(rule.id, { status: explicit ? "kept" : "suggested" });
        }
      } else {
        rule = await addLifeRule({
          text,
          status: explicit ? "kept" : "suggested",
          createdAt: time,
        });
        isNew = true;
      }
    }

    // A rule written down fresh with nothing about the moment is just the
    // rule. Anything else — one already on the list, or a when/why — is a
    // time it came up.
    const moment = !isNew || situation !== null || belief !== null || actedOn !== null;
    if (moment) {
      await addLifeRuleLog({ rule, situation, belief, actedOn, loggedAt: time });
    }
    ctx.logged++;
    notifyDiaryChanged();
    if (isNew) {
      return `Wrote down rule #${rule.id} "${rule.text}"${rule.status === "suggested" ? " as a suggestion for them to confirm" : ""}${moment ? `, and logged it coming up at ${time}` : ""}.`;
    }
    return `Logged rule #${rule.id} "${rule.text}" coming up at ${time}.`;
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
  const [catalog, diary, region] = await Promise.all([
    listSupplements(),
    loadDiaryContext(capture.day),
    foodRegion(),
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

  const foodCountry = region.cc ? regionLabel(region) : null;
  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(capture, catalog, diary, foodCountry) },
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
            "exercise, supplement, feeling or rule for living, record it NOW by calling the " +
            "matching tool (log_meal / log_workout / log_supplement / log_state / add_rule / " +
            "log_rule) — a rough estimate is better " +
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
