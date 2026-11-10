/**
 * Fire-and-forget diary agent.
 *
 * A capture (photo and/or note) is stored instantly and resolved in the
 * background: the model sees the current time and the
 * diary around this day, then records entries exclusively through tool calls
 * (log_meal / repeat_meal / log_saved_meal / log_workout / log_reading /
 * log_performance / log_state /
 * add_rule / log_rule), so phrases like
 * "ate this earlier today" get a concrete timestamp and "one more of those"
 * gets the same numbers as the first one. Successful captures are deleted;
 * failures stay visible in the timeline with a retry.
 *
 * It also decides, per food entry, whether it breaks a fast (`fast_ok`):
 * judged against the running fast's purpose and what's been eaten since it
 * started, or against a plain fast when none is running. There is no fixed
 * calorie threshold — an unmarked entry counts as eating.
 */
import {
  addCapture,
  addFoodEntry,
  addLifeRule,
  addBloodReading,
  addPerformanceLog,
  addLifeRuleLog,
  addStateLog,
  addWorkout,
  deleteCapture,
  deletePhotoIfUnused,
  findLifeRuleByText,
  getActiveFast,
  getCapture,
  getLifeRule,
  getFoodEntry,
  getSavedMeal,
  getSetting,
  listFoodEntriesForDay,
  listFoodEntriesForRange,
  listLifeRules,
  listPendingCaptures,
  listSavedMeals,
  listStateCategories,
  listSupplementLogsForDay,
  listWorkoutsForDay,
  setCaptureStatus,
  setGlucoseUnit,
  todayStr,
  updateLifeRule,
} from "./db";
import { chatWithTools } from "./openrouter";
import type { ChatMessage, ContentPart, ToolDef } from "./openrouter";
import { parseLabelArgs, parsePerformanceStatArgs, parseToolArgs } from "./schemas";
import { unlockAchievement } from "./achievements";
import {
  FOOD_FACTS_TOOL,
  executeFoodFactsSearch,
  foodRegion,
  labelPortion,
  regionLabel,
} from "./openFoodFacts";
import { NUTRIENT_DEFS, sanitizeNutrients, scaleNutrients } from "./nutrients";
import { iconKeys, isIconKey } from "./icons";
import { stateKey } from "./states";
import { clampBelief, isActedOn } from "./lifeRules";
import {
  MGDL_PER_MMOL,
  READING_DEFS,
  glucoseMmolFromEither,
  isReadingKind,
} from "./readings";
import type { GlucoseUnit } from "./readings";
import { STAT_DEFS, customMetricKey, statDef, statKeys } from "./performance";
import { onAppResume, wasSuspendedSince } from "./appLifecycle";
import { withBackgroundTask } from "./background";
import { readPhotoDataUrl, savePhoto } from "./photos";
import { dayOf, shiftDay, timeOf } from "./daystamp";
import type {
  Capture,
  Fast,
  FoodEntry,
  LifeRule,
  SavedMeal,
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
  "Times the user mentions are already in their local timezone, pass them through VERBATIM " +
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
    props[d.key] = {
      type: "number",
      description:
        d.key === "alcohol_g"
          ? "Grams of ethanol, for alcoholic drinks: ml × ABV × 0.789 (33 cl of 5% beer ≈ 13 g, " +
            "15 cl of 12% wine ≈ 14 g, 4 cl of 40% spirits ≈ 13 g). Its 7 kcal/g are part of calories."
          : `${d.label} in ${d.unit}`,
    };
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

/** On every food-logging tool: the agent's call on whether it breaks a fast. */
const FAST_OK_PARAM = {
  type: "string",
  description:
    "Set ONLY when this entry does NOT break a fast (see the fasting rule in your instructions): " +
    'a few words why, e.g. "black coffee", "within the 225 kcal allowance (190 so far)". ' +
    "Omit it when it breaks one.",
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
          fast_ok: FAST_OK_PARAM,
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
          zone2_min: { type: "number", description: "Zone 2 minutes from the diary note or screenshot. For a session described as Zone 2 (or Z2), use its duration automatically; for a mixed session, use the Zone 2 portion. Never require a separate log. Do not infer from activity type or average heart rate alone. Omit if unknown." },
        },
        required: ["title", "time", "calories_burned"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "log_state",
      description:
        "Record how they FEEL, a symptom, a mood, a state of body or mind: \"bloated\", " +
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
              "Anything else they said about it, how bad, how long, what it followed. Their words, not yours.",
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
      name: "log_reading",
      description:
        "Record a blood reading off a meter, usually a photo of a FreeStyle Precision Neo's " +
        "screen, or a number in the note. Glucose and β-ketones come from different strips; " +
        "one call per number (a glucose AND a ketone reading is two calls with the same time). " +
        "Copy the number exactly as the screen shows it, never estimate one. A screen saying " +
        "LO or HI has no number: don't log it, say so.",
      parameters: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: ["glucose", "ketone"],
            description:
              "\"ketone\" when the screen shows a ketone strip or the KETONE label (always mmol/L, " +
              "typically 0.0-8.0); \"glucose\" otherwise.",
          },
          value: { type: "number", description: "The number on the screen." },
          unit: {
            type: "string",
            enum: ["mmol/L", "mg/dL"],
            description: "The unit printed on the screen. Ketones are always mmol/L.",
          },
          note: {
            type: "string",
            description:
              "Anything they said about it, fasted, after a meal, after a workout. Their words.",
          },
          time: {
            type: "string",
            description:
              TIME_DESC +
              " When the meter screen shows the reading's own time, use it if it's plausible (the diary day, not in " +
              "the future), meter clocks are often never set, and then the photo's moment is the better guess.",
          },
        },
        required: ["kind", "value", "time"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "log_performance",
      description:
        "Record fitness/performance stats read off a watch or training app, usually a Garmin " +
        "Connect screenshot (Performance Stats, HRV Status, Training Readiness, Race Predictor, " +
        "a power-meter FTP test), or numbers in the note. ONE call per screenshot/note with " +
        "every stat it shows in `stats`. Copy numbers exactly as shown, never estimate one. " +
        "Use this for stats about fitness, not for a single workout (that is log_workout).",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: 'Short heading, max 5 words, e.g. "Garmin performance stats", "FTP test".',
          },
          stats: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              properties: {
                metric: {
                  type: "string",
                  enum: [...statKeys(), "other"],
                  description:
                    "Which stat. " +
                    statKeys()
                      .map((k) => `${k}: ${STAT_DEFS[k].hint}`)
                      .join("; ") +
                    '; other: anything else numeric on the screen (give label and unit).',
                },
                value: {
                  type: "number",
                  description:
                    "The number shown, in the stat's unit. Paces and race times as SECONDS (see the metric list).",
                },
                label: {
                  type: "string",
                  description: 'Only for metric "other": the stat\'s name as the screen shows it.',
                },
                unit: {
                  type: "string",
                  description: 'Only for metric "other": its unit, if any.',
                },
              },
              required: ["metric", "value"],
              additionalProperties: false,
            },
          },
          note: {
            type: "string",
            description:
              "Anything else worth keeping that isn't a number: HRV status (\"Balanced\"), " +
              "training status (\"Productive\"), or what they said about it.",
          },
          time: {
            type: "string",
            description:
              TIME_DESC + " For a screenshot with no time on it, use the time the capture was made.",
          },
        },
        required: ["title", "stats", "time"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "repeat_meal",
      description:
        "Log another serving of something already in the diary, \"one more cheese cube\", " +
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
          fast_ok: FAST_OK_PARAM,
        },
        required: ["id", "time"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "log_saved_meal",
      description:
        "Log one of their SAVED MEALS (listed by #id in your instructions): meals they kept with " +
        "exact numbers, often a shop's official values. Whenever what they ate is one of those, " +
        "by name, brand, or a photo of it, use this instead of log_meal or a product search, so it " +
        "counts exactly as saved.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "number", description: "Saved meal id (the #number) from your instructions" },
          portion: {
            type: "number",
            description:
              "Multiple of the saved portion: 1 (default) for one, 2 for two, 0.5 for half.",
          },
          time: { type: "string", description: TIME_DESC },
          fast_ok: FAST_OK_PARAM,
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
        "or what they are, \"I must always do things perfectly\", \"I'm a man, so I'm dangerous\", " +
        "\"if I rest, I'm lazy\". Not a passing feeling (that is log_state): a rule is general and " +
        "they live by it. If the rule is already on their list, use log_rule instead. " +
        "Pass `situation` when the note also says when or why it came up, so that moment is logged too.",
      parameters: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description:
              "The rule in THEIR exact words, copied from the note character for character, same " +
              "language, same wording. Never translate, shorten, soften, correct or rephrase it. " +
              "Drop only a lead-in like \"new rule:\" / \"ny leveregel:\".",
          },
          explicit: {
            type: "boolean",
            description:
              "true when they SAID this is a rule (\"new rule: …\", \"ny leveregel: …\", \"a rule I " +
              "have is …\"). false when you recognised a rule in what they wrote without them calling " +
              "it one, it is then saved as a suggestion they confirm or dismiss.",
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
  /** Meals they saved for reuse, with exact numbers. */
  savedMeals: SavedMeal[];
  /** The running fast, if any — entries are judged against its purpose. */
  fast: Fast | null;
  /** Everything eaten since that fast started, marked or not, oldest first. */
  fastEntries: FoodEntry[];
}

const RECENT_DAYS = 7;
const MAX_RECENT = 10;

async function loadDiaryContext(day: string): Promise<DiaryContext> {
  const before = shiftDay(day, -RECENT_DAYS);
  const [meals, workouts, supplements, week, allRules, savedMeals, fast] = await Promise.all([
    listFoodEntriesForDay(day).catch(() => []),
    listWorkoutsForDay(day).catch(() => []),
    listSupplementLogsForDay(day).catch(() => []),
    listFoodEntriesForRange(before, shiftDay(day, -1)).catch(() => []),
    listLifeRules().catch(() => [] as LifeRule[]),
    listSavedMeals().catch(() => [] as SavedMeal[]),
    getActiveFast().catch(() => null),
  ]);
  // Strictly after the start: the meal a fast is anchored to isn't in it.
  // From the day before the start too, in case the fast began further west.
  const fastEntries = fast
    ? (
        await listFoodEntriesForRange(
          shiftDay(fast.start_day ?? dayOf(fast.started_at), -1),
          todayStr(),
        ).catch(() => [] as FoodEntry[])
      )
        .filter((e) => e.eaten_at > fast.started_at)
        .sort((a, b) => a.eaten_at.localeCompare(b.eaten_at))
    : [];
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
  return { meals, workouts, supplements, recentMeals, rules, savedMeals, fast, fastEntries };
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
          `, ${kcalOf(m)} kcal${p != null ? `, ${Math.round(p)}g protein` : ""}`,
      );
    }
    for (const w of ctx.workouts) {
      lines.push(
        `  ${timeOf(w.performed_at, w.tz_offset_min)} did "${w.title}"` +
          `, ${Math.round(w.calories_burned)} kcal burned` +
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

  if (ctx.savedMeals.length > 0) {
    lines.push("Saved meals (for log_saved_meal, exact numbers they kept):");
    for (const m of ctx.savedMeals) {
      const kcal = Math.round(m.nutrients.calories ?? 0);
      lines.push(`  #${m.id} "${m.name}", ${kcal} kcal${m.description ? `: ${m.description}` : ""}`);
    }
  }

  lines.push(...renderFastContext(ctx));

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

/** The running fast and what's been eaten in it — what `fast_ok` is judged on. */
function renderFastContext(ctx: DiaryContext): string[] {
  const fast = ctx.fast;
  if (!fast) return ["No fast is running."];
  const startDay = fast.start_day ?? dayOf(fast.started_at, fast.tz_offset_min);
  const start = `${startDay} ${timeOf(fast.started_at, fast.tz_offset_min)}`;
  const lines = [
    `A fast is running: started ${start}, goal ${fast.goal_hours} h.`,
    fast.purpose
      ? `  Its purpose, in their words: "${fast.purpose}"`
      : "  No purpose given, a plain fast.",
  ];
  if (ctx.fastEntries.length === 0) {
    lines.push("  Nothing eaten since it started.");
  } else {
    lines.push("  Eaten since it started:");
    let allowed = 0;
    for (const e of ctx.fastEntries) {
      const verdict = e.fast_ok_note
        ? `fits the fast (${e.fast_ok_note})`
        : "counted as breaking it";
      if (e.fast_ok_note) allowed += kcalOf(e);
      lines.push(
        `    #${e.id} ${dayOf(e.eaten_at, e.tz_offset_min)} ${timeOf(e.eaten_at, e.tz_offset_min)} "${e.title}" (${kcalOf(e)} kcal) ${verdict}`,
      );
    }
    lines.push(`  Total of the entries that fit the fast: ${allowed} kcal.`);
  }
  return lines;
}

function buildSystemPrompt(
  capture: Capture,
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
  return [
    "You are Tally's diary agent. The user captured a photo and/or a short note; record what happened using ONLY the provided tools.",
    `Current local date & time: ${weekday} ${local} (${tzOffsetLabel(now)}).`,
    `Diary day being added to: ${capture.day}${isToday ? " (today)" : " (a past day, with no time clue, use 12:00)"}.`,
    "",
    renderDiaryContext(diary, capture.day, isToday),
    "",
    "Rules:",
    "- The listing above is what is ALREADY recorded. It is context, never a reason to skip logging: this capture is something new unless the note says otherwise.",
    "- When the note points back at one of those entries, \"one more cheese cube\", \"another coffee\", \"same as this morning\", \"the usual\", call repeat_meal with that entry's id instead of estimating again. Two of the same thing should count the same both times.",
    "- When what they ate is one of their saved meals listed above (by name, brand or what the photo shows) → log_saved_meal with its #id, before considering log_meal or search_packaged_food. A saved meal holds numbers they checked; never re-estimate it.",
    "- Decide what the capture shows: food/drink → log_meal; supplements count as food (see below) → log_meal; exercise → log_workout; a blood meter screen (glucose or ketones) → log_reading; fitness stats from a watch/training app (FTP, VO2 max, HRV, lactate threshold, training readiness, race predictions) → log_performance; how they FEEL (a symptom, a mood, a state, \"bloated\", \"low all afternoon\", \"headache\") → log_state; a RULE FOR LIVING → add_rule / log_rule (below).",
    "- Rules for living (\"leveregler\") are standing beliefs about how they must be or what they are: \"I must always…\", \"I'm X, so I'm Y\", \"if I…, then…\". When the note points at one already listed above (same idea, even in other words) → log_rule with its #id. When they declare a new one (\"new rule: …\", \"ny leveregel: …\") → add_rule with explicit=true. When they state a rule-shaped belief that isn't listed and didn't call it a rule → add_rule with explicit=false (it becomes a suggestion they confirm). A feeling about one moment (\"felt useless today\") is a state, not a rule; when unsure, use log_state.",
    "- A rule's text is THEIR words, copied verbatim in the language they wrote it in. Never translate, tidy, soften or rephrase it. Don't argue with a rule, reassure them about it or comment on it in your confirmation, only say what was recorded.",
    `- Branded/packaged products (wrappers, bottles, cans, labels, barcodes): look them up with search_packaged_food first, by the barcode digits when the photo shows them legibly, else by the name as printed on the package. ${foodCountry == null ? "" : `Searches cover products sold in ${foodCountry} first, then worldwide; prefer a match sold in their country. `}When a result is what was eaten, call log_meal with \`label\` (its barcode plus grams, servings or packages) and let Tally do the label arithmetic; put in \`nutrients\` only what the label lacks (usually the micronutrients). Never search for home-cooked or generic foods; if the search fails or nothing matches, estimate everything yourself and log without \`label\`.`,
    "- Supplements are food: \"800mg fish oil\", \"2 tsp psyllium husk\", \"magnesium\" → log_meal with icon \"supplement\", titled by what it is and how much (\"Fish oil 800 mg\"), and `nutrients` for the AMOUNT TAKEN, e.g. the omega-3 in 800 mg of fish oil (and its EPA + DHA as epa_dha_g), the fiber in the husk, the magnesium in the dose, beta-alanine in a pre-workout as beta_alanine_g. A supplement photo or label shows the dose; with no amount given, assume one typical serving and say so in the description. \"The usual\"/\"same as yesterday\" → repeat_meal like any food.",
    "- Never use em dashes in anything you write (titles, notes, replies). Use a comma, a colon or a new sentence.",
    "- A capture may contain several items (e.g. a meal AND a supplement), make one tool call per item.",
    "- All times are LOCAL to the user (timezone above). Explicit times in the note are already local wall-clock, repeat them verbatim, never convert to UTC or any other timezone. Relative phrases estimated; no time clue → current time. Never a future time.",
    "- For meals, estimate TOTAL nutrients for the visible portion; omit keys you cannot estimate. Any alcoholic drink gets alcohol_g (grams of ethanol), and its calories include the alcohol's. Fish, seafood, fish oil and algae oil get epa_dha_g (the EPA + DHA part of their omega-3) alongside omega3_g; plant omega-3 (flax, chia, walnuts) is ALA and gets no epa_dha_g.",
    "- Fasting: on log_meal / repeat_meal / log_saved_meal, set `fast_ok` to a short reason when the entry does NOT break a fast, and omit it when it does. There is no fixed calorie cutoff, it's your judgement. When a fast is running (see above) and the entry's time is after it started, judge by its purpose: an allowance is a running total, so add up the entries already marked as fitting plus anything else you log in this capture, with \"up to 225 kcal\" and 150 used, a 100 kcal snack breaks it; with \"400 kcal a day\", count only that local day's entries. With no purpose given, or no fast running, or an entry from before the fast began, judge it as a plain fast: water, black coffee, plain tea and supplements with negligible calories fit; anything with real calories (milk in coffee beyond a splash, broth with fat, a snack) does not. When unsure, leave it out: the user is shown unmarked entries during a fast and decides. When a fast is running and something you log breaks it, say so in your confirmation.",
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
  /**
   * The photo a reading took. A meter photo can show a glucose and a ketone
   * reading together, and both are read off it, so both keep it.
   */
  readingPhoto: string | null;
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

/** The agent's reason an entry doesn't break a fast, or null when it does. */
function fastOk(v: unknown): string | null {
  return str(v)?.slice(0, 200) ?? null;
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
      fast_ok_note: fastOk(args["fast_ok"]),
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
      return `Error: there is no diary entry #${Math.round(rawId)}, log it with log_meal instead.`;
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
      fast_ok_note: fastOk(args["fast_ok"]),
    });
    ctx.logged++;
    notifyDiaryChanged();
    return `Logged "${title}" at ${time}, copied from #${source.id}.`;
  }

  if (name === "log_saved_meal") {
    const rawId = num(args["id"]);
    if (rawId == null) return "Error: id is required.";
    const saved = await getSavedMeal(Math.round(rawId));
    if (!saved) {
      return `Error: there is no saved meal #${Math.round(rawId)}, log it with log_meal instead.`;
    }
    const portion = Math.min(20, Math.max(0.05, num(args["portion"]) ?? 1));
    const title = portion === 1 ? saved.name : `${saved.name} (${round2(portion)}×)`;
    const photo = ctx.photoToAttach;
    ctx.photoToAttach = null;
    await addFoodEntry({
      eaten_at: time,
      title,
      description: saved.description,
      photo_path: photo,
      nutrients: sanitizeNutrients(scaleNutrients(saved.nutrients, portion)),
      // The numbers are the saved meal's, not this model's guess.
      model_id: null,
      icon: saved.icon,
      fast_ok_note: fastOk(args["fast_ok"]),
    });
    ctx.logged++;
    notifyDiaryChanged();
    return `Logged saved meal "${title}" at ${time}.`;
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
      zone2_min: num(args["zone2_min"]),
      model_id: ctx.model,
      icon: icon(args["icon"]),
    });
    ctx.logged++;
    notifyDiaryChanged();
    return `Logged workout "${title}" at ${time}.`;
  }

  if (name === "log_reading") {
    const kind = args["kind"];
    if (!isReadingKind(kind)) return 'Error: kind must be "glucose" or "ketone".';
    const raw = num(args["value"]);
    if (raw === null) return "Error: value must be the number on the screen.";
    const unitArg = str(args["unit"])?.toLowerCase().replace(/\s/g, "");
    const unit: GlucoseUnit | null =
      unitArg === "mg/dl" ? "mgdl" : unitArg === "mmol/l" ? "mmol" : null;
    const value =
      kind === "glucose"
        ? unit === "mgdl"
          ? raw / MGDL_PER_MMOL
          : unit === "mmol"
            ? raw
            : glucoseMmolFromEither(raw)
        : raw;
    const { min, max, label } = READING_DEFS[kind];
    if (value < min || value > max) {
      return `Error: ${raw}${unitArg ? ` ${args["unit"]}` : ""} is outside what the meter can read for ${label.toLowerCase()}, check the number and unit.`;
    }
    const photo = ctx.photoToAttach ?? ctx.readingPhoto;
    ctx.photoToAttach = null;
    ctx.readingPhoto = photo;
    await addBloodReading({
      kind,
      value,
      note: str(args["note"]),
      measuredAt: time,
      photoPath: photo,
    });
    // The meter's unit is the one to show glucose in from here on.
    if (kind === "glucose" && unit) await setGlucoseUnit(unit);
    ctx.logged++;
    notifyDiaryChanged();
    return `Logged ${label.toLowerCase()} ${raw}${unitArg ? ` ${args["unit"]}` : ""} at ${time}.`;
  }

  if (name === "log_performance") {
    const title = str(args["title"]) ?? "Performance stats";
    const stats: { metric: string; label: string; value: number; unit: string | null }[] = [];
    const rejected: string[] = [];
    for (const { metric, value, label, unit } of parsePerformanceStatArgs(args["stats"])) {
      const def = statDef(metric);
      if (def) {
        if (value < def.min || value > def.max) {
          rejected.push(`${def.label} ${value}`);
          continue;
        }
        stats.push({ metric, label: def.label, value, unit: def.unit });
      } else {
        // "other", or a key the model made up: kept under its own label.
        const name = label ?? (metric === "other" ? null : metric);
        if (!name) continue;
        stats.push({ metric: customMetricKey(name), label: name, value, unit });
      }
    }
    if (stats.length === 0) {
      return rejected.length > 0
        ? `Error: ${rejected.join(", ")} is outside what that stat can be, check the number and unit (paces and times in seconds).`
        : "Error: no stats with a number to record.";
    }
    const photo = ctx.photoToAttach;
    ctx.photoToAttach = null;
    await addPerformanceLog({
      title,
      note: str(args["note"]),
      photoPath: photo,
      modelId: ctx.model,
      measuredAt: time,
      stats,
    });
    ctx.logged++;
    notifyDiaryChanged();
    return (
      `Logged ${stats.length} performance stat${stats.length === 1 ? "" : "s"} at ${time}.` +
      (rejected.length > 0
        ? ` Skipped ${rejected.join(", ")}: outside what that stat can be (paces and times are seconds), call again with the corrected value if you misread it.`
        : "")
    );
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
  const [diary, region] = await Promise.all([
    loadDiaryContext(capture.day),
    foodRegion(),
  ]);

  const parts: ContentPart[] = [
    {
      type: "text",
      text: capture.note?.trim()
        ? `Note from the user: ${capture.note.trim()}`
        : "No note, go by the photo.",
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
    { role: "system", content: buildSystemPrompt(capture, diary, foodCountry) },
    { role: "user", content: parts },
  ];

  const ctx: ToolContext = {
    capture,
    model,
    photoToAttach: capture.photo_path,
    readingPhoto: null,
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
            "exercise, supplement, meter reading, performance stats, feeling or rule for living, record it NOW by calling the " +
            "matching tool (log_meal / log_workout / log_reading / log_performance / log_state / " +
            "add_rule / log_rule), a rough estimate is better " +
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
    // Nothing took the photo (e.g. only a state was logged). Guard anyway
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
