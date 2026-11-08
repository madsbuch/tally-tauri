/**
 * Data assistant — a conversational agent with read-only tool access to
 * everything Tally stores: meals, workouts (incl. Garmin), sleep, daily
 * wellness metrics, supplements, and fasts. Structured query tools cover the
 * common cases; a guarded SELECT-only SQL tool handles everything else.
 */
import { diaryZone2Minutes } from "./exerciseGoals";
import {
  addCoachMemory,
  addEntryNote,
  addLifeRule,
  describeNotedEntry,
  isNotedEntryKind,
  listEntryNotesFor,
  findLifeRuleByText,
  updateLifeRule,
  deleteCoachMemory,
  getDb,
  getSetting,
  todayStr,
  updateCoachMemory,
  listDocumentsForRange,
  listFoodEntriesForRange,
  listHealthMetricsForRange,
  listRecentFasts,
  listSleepForRange,
  listSupplementLogsForRange,
  listSupplements,
  listWorkoutsForRange,
  getActiveFast,
  getFoodEntry,
  listSavedMeals,
  saveMeal,
  renameSavedMeal,
  deleteSavedMeal,
  getManual,
} from "./db";
import { createManual, isManualTrigger, removeManual, saveManual } from "./manuals";
import { chatWithTools } from "./openrouter";
import { notifyDiaryChanged } from "./agent";
import type { ChatMessage, ToolDef } from "./openrouter";
import { parseToolArgs } from "./schemas";
import { garminDetailsForWorkouts, listGarminDaysForRange } from "./garminDb";
import type { GarminWorkoutDetail } from "./garminDb";
import { FOOD_FACTS_TOOL, executeFoodFactsSearch } from "./openFoodFacts";
import {
  CAFFEINE_SLEEP_MG,
  CREATINE_WORKING,
  levelsAt,
  loadBodySnapshot,
  loadIntake,
  loadProfile,
  localStamp,
  parseLocalMoment,
} from "./body";
import { GRAMS_PER_DRINK } from "./bodyModel";
import { shiftDay } from "./daystamp";
import {
  CALORIE_FIGURE_KEYS,
  CALORIE_GROUPINGS,
  CALORIES_TOOL_DESCRIPTION,
  parseCalorieFigures,
  parseCalorieGrouping,
  readCalories,
} from "./calories";
import { DEFAULT_VISION_MODEL, SETTING_KEYS } from "./types";
import type { Nutrients } from "./types";

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const DAY_RANGE_PROPS = {
  start_day: {
    type: "string",
    description: 'First local day of the range, "YYYY-MM-DD" (inclusive).',
  },
  end_day: {
    type: "string",
    description: 'Last local day of the range, "YYYY-MM-DD" (inclusive).',
  },
} as const;

const DAY_RANGE_SCHEMA = {
  type: "object",
  properties: DAY_RANGE_PROPS,
  required: ["start_day", "end_day"],
  additionalProperties: false,
} as const;

export const ASSISTANT_TOOLS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "query_calories",
      description: CALORIES_TOOL_DESCRIPTION,
      parameters: {
        type: "object",
        properties: {
          ...DAY_RANGE_PROPS,
          figures: {
            type: "array",
            items: { type: "string", enum: CALORIE_FIGURE_KEYS },
            description: "Which figures to return. Omit for all of them.",
          },
          group_by: {
            type: "string",
            enum: CALORIE_GROUPINGS,
            description:
              "day (default): a row per day. week / month: a row per Monday-to-Sunday week or calendar month, each with its own totals and averages.",
          },
        },
        required: ["start_day", "end_day"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "query_meals",
      description:
        "Food diary entries in a day range, with estimated nutrients (calories, macros, micros).",
      parameters: DAY_RANGE_SCHEMA,
    },
  },
  {
    type: "function",
    function: {
      name: "query_workouts",
      description:
        "Exercise sessions in a day range — manual entries and Garmin/Health Connect synced ones (calories burned, duration, distance/HR in the description). Synced ones carry `garmin` when the direct Garmin Connect sync has them: Training Effect (aerobic/anaerobic, 0–5), training load, minutes in HR zones 1–5, power, cadence, pace, elevation, and laps.",
      parameters: DAY_RANGE_SCHEMA,
    },
  },
  {
    type: "function",
    function: {
      name: "query_sleep",
      description:
        "Sleep sessions (from Garmin/Health Connect) whose wake-up falls in the day range: duration and deep/REM/light/awake stage minutes.",
      parameters: DAY_RANGE_SCHEMA,
    },
  },
  {
    type: "function",
    function: {
      name: "query_health_metrics",
      description:
        "Daily wellness metrics (from Garmin/Health Connect) per local day: steps, resting heart rate, HRV (RMSSD ms), blood oxygen %, weight kg, VO2 max, total calories burned (burned_total; query_calories sets it against what was eaten).",
      parameters: DAY_RANGE_SCHEMA,
    },
  },
  {
    type: "function",
    function: {
      name: "query_garmin_wellness",
      description:
        "Garmin Connect's own daily numbers (direct sync, not Health Connect) per day: Body Battery (high/low/charged/drained), stress (avg/max, 0–100), HRV last night + weekly avg + status, sleep score/stress/respiration, intensity minutes, floors, respiration, SpO2, resting HR, steps, weight. Training readiness (score + level), training status (e.g. PRODUCTIVE, MAINTAINING), acute/chronic load and VO2 max only for recent days, and only when the optional unofficial sign-in is on — absent otherwise, which says nothing about the day.",
      parameters: DAY_RANGE_SCHEMA,
    },
  },
  {
    type: "function",
    function: {
      name: "query_supplements",
      description:
        "The supplement catalog (names, default doses, per-dose nutrients) plus intake logs in a day range.",
      parameters: DAY_RANGE_SCHEMA,
    },
  },
  {
    type: "function",
    function: {
      name: "query_fasts",
      description:
        "The currently active fast (if any) and recently completed fasts with goal, purpose (what they set out to do, e.g. an allowed kcal budget) and actual duration.",
      parameters: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Max completed fasts to return (default 20).",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_sql",
      description:
        "Run a single read-only SELECT against the local SQLite database for anything the other tools can't answer (aggregates, joins, trends). The schema is in the system prompt. Timestamps are ISO-8601 UTC strings.",
      parameters: {
        type: "object",
        properties: {
          sql: {
            type: "string",
            description: "One SELECT statement (CTEs allowed). No writes.",
          },
        },
        required: ["sql"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "query_documents",
      description:
        "Documents the user has photographed into their library — blood panels, scan reports, letters — with the measurements read off them. Filed by the date printed on the document, not when it was added. Use this whenever a question touches lab values, a diagnosis, or anything a clinician wrote down.",
      parameters: {
        type: "object",
        properties: {
          start_day: {
            type: "string",
            description: 'Earliest document date, "YYYY-MM-DD". Omit for no lower bound.',
          },
          end_day: {
            type: "string",
            description: 'Latest document date, "YYYY-MM-DD". Omit for no upper bound.',
          },
        },
        additionalProperties: false,
      },
    },
  },
  FOOD_FACTS_TOOL,
  {
    type: "function",
    function: {
      name: "add_rule",
      description:
        "Add a rule for living (\"leveregel\") to their list — a standing belief like \"I must always do things perfectly\". ONLY once they have agreed to the exact wording: if you helped put it into words, read the sentence back and wait for a yes before calling this. It is saved verbatim as theirs, so never paraphrase what they agreed to.",
      parameters: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "The rule, word for word as they agreed to it, in their language.",
          },
          alternative: {
            type: "string",
            description: "The rule they want to practise instead, if they named one. Omit otherwise.",
          },
        },
        required: ["text"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "annotate_entry",
      description:
        "Attach a short note to ONE diary entry: context that explains its number without changing it — " +
        "\"Taken ~10 min after a coffee with milk\" on a glucose reading that came out high, \"First run " +
        "after a week sick\" on a slow workout. It shows on that entry for them and comes back to you " +
        "whenever the entry does (the query_* tools return it as coach_notes; for readings, states and " +
        "performance logs, join entry_notes in SQL). Use it when you've spotted context in the diary or " +
        "they've told you something about a specific entry. It never edits the entry; a recurring pattern " +
        "(\"glucose reads high after coffee\") belongs in `remember` instead. One note per thing — don't " +
        "repeat what the entry or an earlier note already says.",
      parameters: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: ["meal", "workout", "reading", "state", "performance", "sleep"],
            description:
              "Which table the entry is in: meal = food_entries, workout = workouts, reading = blood_readings, " +
              "state = state_logs, performance = performance_logs, sleep = sleep_sessions.",
          },
          id: { type: "number", description: "The entry's id, from a query_* tool or run_sql." },
          text: {
            type: "string",
            description:
              "One sentence of context, in the third person, specific: what explains the entry, and how you know.",
          },
        },
        required: ["kind", "id", "text"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "query_body_levels",
      description:
        "What's in their body at one moment, modelled from the diary (the Body tab shows the same): " +
        `caffeine (mg in the body, and when it drops under ${CAFFEINE_SLEEP_MG} mg — roughly where it stops costing deep sleep), ` +
        "alcohol (g, rough ‰, and when it's cleared), creatine (how full the muscle store is from supplements) and " +
        "vitamin D (estimated 25(OH)D blood level in nmol/L: a seasonal northern-European sun baseline plus logged intake, " +
        "pinned to the newest blood test in the library when there is one — otherwise it's an average, not their number; " +
        "includes the µg/day that keeps them over 50 / 75 nmol/L through winter), omega-3 index (%, target 8) and ferritin (µg/L) — " +
        "both pinned to a library blood test when there is one — beta-alanine (muscle carnosine loading), vitamin/mineral reserves " +
        "(folate, iodine, B12, A, E, K as % of full), glycogen (liver and muscle %, pinned by ketone meter readings; when the liver " +
        "drops under 30% with no more carbs), training load (fitness, fatigue and their ratio) and sleep debt (hours). " +
        "Estimates from average kinetics: say so when it matters.",
      parameters: {
        type: "object",
        properties: {
          at: {
            type: "string",
            description:
              'Local time to look at, "YYYY-MM-DD HH:MM" or "HH:MM" (today). Omit for right now. A future time forecasts from what is logged.',
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "query_levels_at_sleep",
      description:
        "For each night in the range: caffeine (mg) and alcohol (g) still in the body when they fell asleep, next to " +
        "that night's sleep (duration, deep, REM, awake). Use it to look for what late coffee or drinks do to THEIR " +
        "sleep — compare nights with more against nights with less, and say how many nights the pattern rests on.",
      parameters: DAY_RANGE_SCHEMA,
    },
  },
  {
    type: "function",
    function: {
      name: "list_saved_meals",
      description:
        "List their SAVED MEALS: meals kept for reuse with exact numbers (often a shop's official " +
        "values, saved from an entry they corrected). The diary logs these with the saved numbers " +
        "whenever they eat them again. Use when they ask what's saved, or to check one before advising.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "save_meal",
      description:
        "Save a diary meal entry for reuse, under a name — when they ask you to keep one " +
        "(\"save yesterday's 7-Eleven bun\"). Saving under a name that already exists updates it " +
        "with this entry's numbers. Find the entry id with query_meals first.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "number", description: "The food entry's id (food_entries.id)." },
          name: {
            type: "string",
            description: "What they'd call it, brand or shop included. Omit to use the entry's title.",
          },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_saved_meal",
      description:
        "Rename or delete one of their saved meals (by id from list_saved_meals). ONLY when they ask. " +
        "Deleting never touches diary entries already logged from it.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "number", description: "Saved meal id." },
          action: { type: "string", enum: ["rename", "delete"] },
          name: { type: "string", description: "The new name, for rename." },
        },
        required: ["id", "action"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remember",
      description:
        "Record something durable about this person so future conversations start knowing it. Use it the moment a goal, a commitment, or a preference comes up — memory is what makes you a coach rather than a stranger each time. Don't record passing facts the diary already holds (what they ate, a single workout); record what shapes how you coach them.",
      parameters: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: ["goal", "commitment", "preference", "note"],
            description:
              "goal = an outcome they want; commitment = something they said they'd do, which you will hold them to; preference = how they want to be coached or what they like; note = anything else worth carrying forward.",
          },
          text: {
            type: "string",
            description:
              "One sentence, in the third person, specific enough to act on later: \"Wants 150 g protein on lifting days\", not \"cares about protein\".",
          },
          follow_up_in_days: {
            type: "number",
            description:
              "Come back to this unprompted in this many days. Use it whenever something is worth revisiting — a symptom they mentioned, a change they're trying, a commitment with a horizon. Judge the interval from the thing itself: a few days for something that should settle quickly, a week or two for a habit. Omit when there is nothing to check back on.",
          },
        },
        required: ["kind", "text"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_memory",
      description:
        "Revise something you remembered, or close out a commitment once it's been met or abandoned. Ids are shown beside each item in your memory.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "number", description: "The id shown in square brackets." },
          text: { type: "string", description: "Replacement text; omit to keep it." },
          status: {
            type: "string",
            enum: ["open", "done", "dropped"],
            description: "Commitments only: where it stands now.",
          },
          follow_up_in_days: {
            type: "number",
            description:
              "Set or move the reminder to this many days from now. After raising a follow-up, use this to come back again if it still needs watching.",
          },
          clear_follow_up: {
            type: "boolean",
            description:
              "Drop the reminder while keeping the memory — the thing is settled but still worth knowing.",
          },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "forget",
      description:
        "Delete something from your memory: it was wrong, it's stale, or they asked you to drop it. Always use this when they ask you to forget something.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "number", description: "The id shown in square brackets." },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_manual",
      description:
        "Read one of their manuals in full. Ids are shown beside each manual in the index. Read a manual before rewriting it, and whenever its situation comes up.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "number", description: "The id shown in square brackets." },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_manual",
      description:
        "Create a manual for a recurring situation, or rewrite one. Rewriting replaces the whole page (the old version is kept in its history), so carry over everything that's still true and keep their own lines as they wrote them.",
      parameters: {
        type: "object",
        properties: {
          id: {
            type: "number",
            description: "The manual to rewrite. Omit to start a new one.",
          },
          title: { type: "string", description: 'Short, e.g. "Fasting".' },
          situation: {
            type: "string",
            description: 'One line on when it applies, e.g. "Fasts longer than a day".',
          },
          applies_when: {
            type: "string",
            enum: ["fasting", "none"],
            description:
              '"fasting" puts this manual in front of you whenever a fast is running (one manual at a time). "none" when the app can\'t tell the situation by itself.',
          },
          body: {
            type: "string",
            description:
              "The whole page, in markdown: a few headings with short imperative bullets, each grounded in what actually happened when you can.",
          },
        },
        required: ["title", "situation", "body"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_manual",
      description: "Delete a manual and its history. Only when they ask for it.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "number", description: "The id shown in square brackets." },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_message",
      description:
        "Deliver a message to the user. This is the ONLY way the user sees anything — plain assistant text is private reasoning. Markdown is rendered.",
      parameters: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description:
              "The message, in concise markdown. Lead with the answer; bold key figures; always include units.",
          },
        },
        required: ["text"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_chart",
      description:
        "Deliver a rendered chart to the user. Use this for trends and comparisons instead of listing numbers — NEVER draw charts as text/ASCII in a message. All series share one unit and one y-axis; use a second chart for a second unit.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short chart title, e.g. 'Sleep — last 7 nights'." },
          type: {
            type: "string",
            enum: ["bar", "line"],
            description: "bar = comparison across categories; line = trend over time.",
          },
          unit: { type: "string", description: "Unit of every value, e.g. 'kcal', 'min', 'bpm'." },
          x_labels: {
            type: "array",
            items: { type: "string" },
            description: "Category/time labels, short, e.g. ['Mon 14','Tue 15']. Max 31.",
          },
          series: {
            type: "array",
            description: "1-3 series. values aligns with x_labels; null = missing.",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                values: { type: "array", items: { type: ["number", "null"] } },
              },
              required: ["name", "values"],
              additionalProperties: false,
            },
          },
        },
        required: ["title", "type", "x_labels", "series"],
        additionalProperties: false,
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Chart spec
// ---------------------------------------------------------------------------

export interface ChartSeries {
  name: string;
  values: (number | null)[];
}

export interface ChartSpec {
  type: "bar" | "line";
  title: string;
  unit?: string;
  x_labels: string[];
  series: ChartSeries[];
}

const MAX_CHART_POINTS = 31;
const MAX_CHART_SERIES = 3;

/** Validate & normalize send_chart args; throws a model-readable error. */
export function sanitizeChart(args: Record<string, unknown>): ChartSpec {
  const type = args["type"] === "line" ? "line" : args["type"] === "bar" ? "bar" : null;
  if (!type) throw new Error('type must be "bar" or "line"');
  const title = typeof args["title"] === "string" ? args["title"].trim() : "";
  if (!title) throw new Error("title is required");
  const xRaw = Array.isArray(args["x_labels"]) ? args["x_labels"] : null;
  if (!xRaw || xRaw.length === 0) throw new Error("x_labels must be a non-empty array");
  if (xRaw.length > MAX_CHART_POINTS) {
    throw new Error(`Too many points (${xRaw.length}) — aggregate to at most ${MAX_CHART_POINTS}`);
  }
  const x_labels = xRaw.map((l) => String(l));
  const sRaw = Array.isArray(args["series"]) ? args["series"] : null;
  if (!sRaw || sRaw.length === 0) throw new Error("series must be a non-empty array");
  if (sRaw.length > MAX_CHART_SERIES) {
    throw new Error(`At most ${MAX_CHART_SERIES} series per chart — split into several charts`);
  }
  const series: ChartSeries[] = sRaw.map((s, i) => {
    const o = (s ?? {}) as Record<string, unknown>;
    const rawName = o["name"];
    const name =
      typeof rawName === "string" && rawName.trim() ? rawName.trim() : `Series ${i + 1}`;
    const vRaw = Array.isArray(o["values"]) ? o["values"] : [];
    const values = x_labels.map((_, j) => {
      const v = vRaw[j];
      const n = typeof v === "string" ? parseFloat(v) : v;
      return typeof n === "number" && isFinite(n) ? n : null;
    });
    if (values.every((v) => v == null)) {
      throw new Error(`series "${name}" has no numeric values`);
    }
    return { name, values };
  });
  const unit =
    typeof args["unit"] === "string" && args["unit"].trim() ? args["unit"].trim() : null;
  return { type, title, ...(unit != null ? { unit } : {}), x_labels, series };
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

/** Round numbers so tool results don't waste tokens on float noise. */
function round(v: number | null | undefined, decimals = 1): number | null {
  if (typeof v !== "number" || !isFinite(v)) return null;
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}

function roundNutrients(n: Nutrients): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(n)) {
    const r = round(v);
    if (r != null) out[k] = r;
  }
  return out;
}

/** Drop null/undefined values — sparse JSON reads better and is cheaper. */
function compact<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v != null) out[k] = v;
  }
  return out;
}

const MAX_ITEMS = 200;
const MAX_SQL_ROWS = 200;

function capList<T>(items: T[]): { items: T[]; note?: string } {
  if (items.length <= MAX_ITEMS) return { items };
  return {
    items: items.slice(0, MAX_ITEMS),
    note: `Truncated to the first ${MAX_ITEMS} of ${items.length} items — narrow the range or use run_sql with aggregates.`,
  };
}

/** A nested group, or nothing when every field in it was empty. */
function group(obj: Record<string, unknown>): Record<string, unknown> | undefined {
  const c = compact(obj);
  return Object.keys(c).length > 0 ? c : undefined;
}

/** What the direct Garmin sync knows about a workout, for the model. */
function garminForCoach(d: GarminWorkoutDetail | undefined): Record<string, unknown> | undefined {
  if (!d) return undefined;
  return group({
    type: d.typeKey,
    distance_km: d.distanceM != null ? round(d.distanceM / 1000, 2) : null,
    avg_hr: round(d.avgHr, 0),
    max_hr: round(d.maxHr, 0),
    aerobic_te: d.aerobicTe,
    anaerobic_te: d.anaerobicTe,
    te_label: d.teLabel,
    training_load: round(d.trainingLoad, 0),
    zone_min: d.zoneSecs?.map((s) => round(s / 60, 0)),
    avg_power: round(d.avgPower, 0),
    norm_power: round(d.normPower, 0),
    avg_cadence: round(d.avgCadence, 0),
    elevation_gain_m: round(d.elevationGainM, 0),
    avg_speed_kmh: d.avgSpeedMps != null ? round(d.avgSpeedMps * 3.6) : null,
    vo2_max: d.vo2Max,
    laps: d.laps?.slice(0, 30).map((l) =>
      compact({
        lap: l.index,
        km: l.distanceM != null ? round(l.distanceM / 1000, 2) : null,
        min: l.durationSec != null ? round(l.durationSec / 60) : null,
        avg_hr: round(l.avgHr, 0),
        avg_power: round(l.avgPower, 0),
      }),
    ),
  });
}

function dayArgs(args: Record<string, unknown>): { start: string; end: string } {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  const start = typeof args["start_day"] === "string" ? args["start_day"] : "";
  const end = typeof args["end_day"] === "string" ? args["end_day"] : "";
  if (!re.test(start) || !re.test(end)) {
    throw new Error('start_day and end_day must be "YYYY-MM-DD"');
  }
  return start <= end ? { start, end } : { start: end, end: start };
}

const SQL_FORBIDDEN =
  /\b(insert|update|delete|drop|alter|create|replace|attach|detach|pragma|vacuum|reindex|begin|commit|rollback)\b/i;

async function runSql(raw: string): Promise<string> {
  const sql = raw.trim().replace(/;\s*$/, "");
  if (sql.includes(";")) throw new Error("Only a single SQL statement is allowed.");
  if (!/^(select|with)\b/i.test(sql)) throw new Error("Only SELECT queries are allowed.");
  if (SQL_FORBIDDEN.test(sql)) {
    throw new Error("Read-only: the query contains a forbidden keyword.");
  }
  const conn = await getDb();
  const rows = (await conn.select(sql)) as Record<string, unknown>[];
  const shown = rows.slice(0, MAX_SQL_ROWS);
  return JSON.stringify({
    rows: shown,
    row_count: rows.length,
    ...(rows.length > MAX_SQL_ROWS ? { note: `Showing first ${MAX_SQL_ROWS} rows.` } : {}),
  });
}

/**
 * "in N days" from the model, as a local day. Clamped: a model that asks for
 * a reminder in 3000 days has made a mistake, and one that asks for a
 * reminder today would fire it on the same evening.
 */
function followUpDay(raw: unknown): string | null {
  const n = typeof raw === "number" ? raw : NaN;
  if (!isFinite(n) || n <= 0) return null;
  const days = Math.min(365, Math.max(1, Math.round(n)));
  const d = new Date();
  d.setDate(d.getDate() + days);
  return todayStr(d);
}

export async function executeAssistantTool(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  if (name === "query_calories") {
    const { start, end } = dayArgs(args);
    return JSON.stringify(
      await readCalories(
        start,
        end,
        parseCalorieFigures(args["figures"]),
        parseCalorieGrouping(args["group_by"]),
      ),
    );
  }

  if (name === "query_meals") {
    const { start, end } = dayArgs(args);
    const meals = await listFoodEntriesForRange(start, end);
    const notes = await listEntryNotesFor("meal", meals.map((m) => m.id));
    const { items, note } = capList(
      meals.map((m) =>
        compact({
          id: m.id,
          day: m.day,
          eaten_at: m.eaten_at,
          title: m.title,
          description: m.description,
          nutrients: roundNutrients(m.nutrients),
          coach_notes: notes.get(m.id),
        }),
      ),
    );
    return JSON.stringify(compact({ meals: items, note }));
  }

  if (name === "query_workouts") {
    const { start, end } = dayArgs(args);
    const workouts = await listWorkoutsForRange(start, end);
    const notes = await listEntryNotesFor("workout", workouts.map((w) => w.id));
    const garmin = await garminDetailsForWorkouts(workouts.map((w) => w.id));
    const { items, note } = capList(
      workouts.map((w) =>
        compact({
          id: w.id,
          day: w.day,
          performed_at: w.performed_at,
          title: w.title,
          description: w.description,
          calories_burned: round(w.calories_burned, 0),
          duration_min: round(w.duration_min, 0),
          zone2_min: diaryZone2Minutes(w),
          cardio: w.cardio || undefined,
          source: w.source ?? "manual",
          coach_notes: notes.get(w.id),
          garmin: garminForCoach(garmin.get(w.id)),
        }),
      ),
    );
    return JSON.stringify(compact({ workouts: items, note }));
  }

  if (name === "query_sleep") {
    const { start, end } = dayArgs(args);
    const sessions = await listSleepForRange(start, end);
    const notes = await listEntryNotesFor("sleep", sessions.map((s) => s.id));
    const { items, note } = capList(
      sessions.map((s) =>
        compact({
          id: s.id,
          day: s.day,
          started_at: s.started_at,
          ended_at: s.ended_at,
          duration_min: round(s.duration_min, 0),
          deep_min: round(s.deep_min, 0),
          rem_min: round(s.rem_min, 0),
          light_min: round(s.light_min, 0),
          awake_min: round(s.awake_min, 0),
          source: s.source,
          coach_notes: notes.get(s.id),
        }),
      ),
    );
    return JSON.stringify(compact({ sleep_sessions: items, note }));
  }

  if (name === "query_garmin_wellness") {
    const { start, end } = dayArgs(args);
    const days = await listGarminDaysForRange(start, end);
    const { items, note } = capList(
      days.map((d) =>
        compact({
          day: d.day,
          body_battery: group({
            high: d.bodyBatteryHigh,
            low: d.bodyBatteryLow,
            charged: d.bodyBatteryCharged,
            drained: d.bodyBatteryDrained,
            at_wake: d.bodyBatteryWake,
          }),
          stress_avg: d.stressAvg,
          stress_max: d.stressMax,
          readiness: d.readinessScore,
          readiness_level: d.readinessLevel,
          training_status: d.trainingStatus,
          acute_load: round(d.acuteLoad, 0),
          chronic_load: round(d.chronicLoad, 0),
          hrv_last_night: d.hrvLastNight,
          hrv_weekly_avg: d.hrvWeeklyAvg,
          hrv_status: d.hrvStatus,
          sleep: group({
            score: d.sleepScore,
            stress: d.sleepStress,
            respiration: d.sleepRespiration,
            body_battery_gained: d.sleepBodyBattery,
          }),
          intensity_min: group({
            moderate: d.intensityMinModerate,
            vigorous: d.intensityMinVigorous,
          }),
          resting_hr: d.restingHr,
          steps: d.steps,
          calories_total: round(d.caloriesTotal, 0),
          calories_active: round(d.caloriesActive, 0),
          floors: round(d.floorsUp, 0),
          respiration_avg: d.respirationAvg,
          spo2_avg: d.spo2Avg,
          vo2_max: d.vo2Max,
          weight_kg: round(d.weightKg),
        }),
      ),
    );
    return JSON.stringify(compact({ days: items, note }));
  }

  if (name === "query_health_metrics") {
    const { start, end } = dayArgs(args);
    const metrics = await listHealthMetricsForRange(start, end);
    const { items, note } = capList(
      metrics.map((m) =>
        compact({
          day: m.day,
          steps: m.steps,
          resting_hr: round(m.resting_hr, 0),
          hrv_ms: round(m.hrv_ms),
          spo2_pct: round(m.spo2_pct),
          weight_kg: round(m.weight_kg),
          vo2_max: round(m.vo2_max),
          calories_total: round(m.calories_total, 0),
        }),
      ),
    );
    return JSON.stringify(compact({ days: items, note }));
  }

  if (name === "query_supplements") {
    const { start, end } = dayArgs(args);
    const [catalog, logs] = await Promise.all([
      listSupplements(true),
      listSupplementLogsForRange(start, end),
    ]);
    return JSON.stringify({
      catalog: catalog.map((s) =>
        compact({
          id: s.id,
          name: s.name,
          dose_amount: s.dose_amount,
          dose_unit: s.dose_unit,
          nutrients_per_dose: roundNutrients(s.nutrients),
          notes: s.notes,
          archived: s.archived ? true : null,
        }),
      ),
      logs: capList(
        logs.map((l) =>
          compact({ day: l.day, taken_at: l.taken_at, name: l.name, doses: round(l.amount) }),
        ),
      ).items,
    });
  }

  if (name === "query_fasts") {
    const limit =
      typeof args["limit"] === "number" && isFinite(args["limit"])
        ? Math.max(1, Math.min(100, Math.round(args["limit"])))
        : 20;
    const [active, recent] = await Promise.all([getActiveFast(), listRecentFasts(limit)]);
    const hours = (startIso: string, endIso: string) =>
      round((new Date(endIso).getTime() - new Date(startIso).getTime()) / 3_600_000);
    return JSON.stringify(
      compact({
        active_fast: active
          ? {
              started_at: active.started_at,
              goal_hours: active.goal_hours,
              purpose: active.purpose,
              elapsed_hours: hours(active.started_at, new Date().toISOString()),
            }
          : null,
        completed_fasts: recent.map((f) =>
          compact({
            started_at: f.started_at,
            ended_at: f.ended_at,
            goal_hours: f.goal_hours,
            purpose: f.purpose,
            actual_hours: f.ended_at ? hours(f.started_at, f.ended_at) : null,
          }),
        ),
      }),
    );
  }

  if (name === "run_sql") {
    if (typeof args["sql"] !== "string" || !args["sql"].trim()) {
      throw new Error("sql is required");
    }
    return runSql(args["sql"]);
  }

  if (name === "query_documents") {
    const start = typeof args["start_day"] === "string" ? args["start_day"] : "0000-01-01";
    const end = typeof args["end_day"] === "string" ? args["end_day"] : "9999-12-31";
    const docs = await listDocumentsForRange(start, end);
    const { items, note } = capList(
      docs.map((d) =>
        compact({
          id: d.id,
          document_date: d.document_date,
          title: d.title,
          kind: d.kind,
          summary: d.summary,
          // Out-of-range results first: on a full panel they're the handful
          // that matter, and the list gets capped.
          values: [...d.extracted]
            .sort(
              (a, b) =>
                Number(b.flag === "low" || b.flag === "high") -
                Number(a.flag === "low" || a.flag === "high"),
            )
            .slice(0, 40)
            .map((v) =>
              compact({
                name: v.name,
                value: v.value,
                unit: v.unit,
                reference: v.reference,
                flag: v.flag === "unknown" ? null : v.flag,
              }),
            ),
          status: d.status === "ready" ? null : d.status,
        }),
      ),
    );
    return JSON.stringify(compact({ documents: items, note }));
  }

  if (name === "search_packaged_food") {
    return executeFoodFactsSearch(args);
  }

  if (name === "add_rule") {
    const text = typeof args["text"] === "string" ? args["text"].trim() : "";
    if (!text) throw new Error("text is required");
    const alternative =
      typeof args["alternative"] === "string" && args["alternative"].trim()
        ? args["alternative"].trim()
        : null;
    const known = await findLifeRuleByText(text);
    if (known) {
      // Agreed to in this conversation, so it is theirs whatever it was before.
      await updateLifeRule(known.id, {
        status: "kept",
        ...(alternative ? { alternative } : {}),
      });
      return JSON.stringify({ already_on_list: known.id, text: known.text });
    }
    const rule = await addLifeRule({ text, alternative, status: "kept" });
    return JSON.stringify({ added_rule: rule.id, text: rule.text });
  }

  if (name === "annotate_entry") {
    const kind = args["kind"];
    if (!isNotedEntryKind(kind)) {
      throw new Error('kind must be one of "meal", "workout", "reading", "state", "performance", "sleep"');
    }
    const id = typeof args["id"] === "number" ? Math.round(args["id"]) : NaN;
    if (!isFinite(id)) throw new Error("id is required");
    const text = typeof args["text"] === "string" ? args["text"].trim() : "";
    if (!text) throw new Error("text is required");
    if (text.length > 500) throw new Error("Keep the note to a sentence or two.");
    const what = await describeNotedEntry(kind, id);
    if (what == null) throw new Error(`There is no ${kind} #${id}.`);
    const noteId = await addEntryNote(kind, id, text);
    notifyDiaryChanged();
    return JSON.stringify({ noted: { id: noteId, on: `${kind} #${id} (${what})`, text } });
  }

  if (name === "query_body_levels") {
    const raw = typeof args["at"] === "string" ? args["at"] : "";
    const atMs = raw ? parseLocalMoment(raw) : Date.now();
    if (atMs == null) throw new Error('at must be "YYYY-MM-DD HH:MM" or "HH:MM"');
    const b = await loadBodySnapshot(new Date(atMs));
    const stamp = (ms: number | null) => (ms == null ? "not within 48 h" : localStamp(ms));
    return JSON.stringify({
      at: localStamp(b.at),
      caffeine: compact({
        mg_in_body: round(b.caffeine.now, 0),
        [`under_${CAFFEINE_SLEEP_MG}mg_at`]: stamp(b.caffeine.belowSleepAt),
        half_life_h: b.profile.caffeineHalfLifeH,
        doses_last_8h: b.caffeine.doses.map((d) => `${localStamp(d.at).slice(11)} ${round(d.amount, 0)} mg`),
      }),
      alcohol: compact({
        g_in_body: round(b.alcohol.now, 1),
        drinks_in_body: round(b.alcohol.now / GRAMS_PER_DRINK, 1),
        promille_rough: round(b.alcohol.promille, 2),
        cleared_at: b.alcohol.now > 0.1 ? stamp(b.alcohol.goneAt) : undefined,
      }),
      creatine: compact({
        store_full_pct: round(b.creatine.fraction * 100, 0),
        avg_g_per_day_last_7d: round(b.creatine.avg7, 1),
        days_to_90pct_at_that_pace: b.creatine.daysToFull,
        [`drops_under_${Math.round(CREATINE_WORKING * 100)}pct_on_if_stopped`]: b.creatine.belowWorkingOn ?? "already under",
        last_taken: b.creatine.lastDay,
      }),
      vitamin_d: compact({
        estimated_level_nmol_l: round(b.vitaminD.level, 0),
        band: b.vitaminD.band.label,
        pinned_to_blood_test: b.vitaminD.test
          ? `${b.vitaminD.test.day}: ${round(b.vitaminD.test.value, 0)} nmol/L`
          : "none — average sun assumed",
        logged_intake_adds_nmol_l: round(b.vitaminD.contribution, 0),
        avg_ug_per_day_last_30d: round(b.vitaminD.avg30, 1),
        [`projected_nmol_l_on_${b.vitaminD.projectedDay}_at_that_pace`]: round(b.vitaminD.projected, 0),
        ug_per_day_to_stay_over_50_through_winter: Math.ceil(b.vitaminD.ugForEnough),
        ug_per_day_to_stay_over_75_through_winter: Math.ceil(b.vitaminD.ugForTarget),
      }),
      omega3_index: compact({
        estimated_pct: round(b.omega3.index, 1),
        band: b.omega3.band.label,
        pinned_to_test: b.omega3.test ? `${b.omega3.test.day}: ${round(b.omega3.test.value, 1)}%` : "none",
        avg_epa_dha_g_per_day_last_30d: round(b.omega3.avg30, 2),
        settles_at_pct: round(b.omega3.settles, 1),
        epa_dha_g_per_day_for_8pct: round(b.omega3.gramsForTarget, 1),
      }),
      ferritin: compact({
        estimated_ug_l: round(b.ferritin.level, 0),
        band: b.ferritin.band.label,
        pinned_to_test: b.ferritin.test ? `${b.ferritin.test.day}: ${round(b.ferritin.test.value, 0)} µg/L` : "none",
        avg_iron_mg_per_day_last_30d: round(b.ferritin.avg30, 1),
        settles_at_ug_l: round(b.ferritin.settles, 0),
      }),
      beta_alanine: compact({
        loaded_pct: round(b.betaAlanine.fraction * 100, 0),
        avg_g_per_day_last_7d: round(b.betaAlanine.avg7, 1),
        last_taken: b.betaAlanine.lastDay,
      }),
      reserves_pct_of_full: Object.fromEntries(
        b.reserves.map((r) => [r.def.label, round(r.fraction * 100, 0)]),
      ),
      glycogen: compact({
        liver_pct: round(b.glycogen.liver * 100, 0),
        muscle_pct: round(b.glycogen.muscle * 100, 0),
        liver_under_30pct_at_if_no_more_carbs:
          b.glycogen.ketosisAt == null ? "not within 24 h" : localStamp(b.glycogen.ketosisAt),
        last_ketone_reading: b.glycogen.lastKetone
          ? `${localStamp(b.glycogen.lastKetone.at)} ${round(b.glycogen.lastKetone.value, 1)} mmol/L`
          : undefined,
      }),
      training_load: compact({
        fitness: round(b.training.fitness, 0),
        fatigue: round(b.training.fatigue, 0),
        fatigue_to_fitness_ratio: b.training.ratio == null ? "too little history" : round(b.training.ratio, 2),
        band: b.training.band?.label,
        workouts_last_7d: b.training.sessions7,
      }),
      sleep: compact({
        debt_h: round(b.sleep.debtH, 1),
        band: b.sleep.band.label,
        avg_h_last_7_nights: b.sleep.avg7H == null ? undefined : round(b.sleep.avg7H, 1),
        need_h: b.sleep.needH,
      }),
      weight_kg_used: b.profile.weightKnown ? round(b.profile.weightKg, 1) : `${b.profile.weightKg} (assumed; none synced)`,
    });
  }

  if (name === "query_levels_at_sleep") {
    const { start, end } = dayArgs(args);
    const [sessions, intake, profile] = await Promise.all([
      listSleepForRange(start, end),
      loadIntake(shiftDay(start, -3), end),
      loadProfile(),
    ]);
    const levels = levelsAt(intake, profile, sessions.map((s) => Date.parse(s.started_at)));
    const { items, note } = capList(
      sessions.map((s, i) =>
        compact({
          night_ending: s.day,
          fell_asleep: localStamp(Date.parse(s.started_at)),
          caffeine_mg_at_sleep: round(levels[i]?.caffeineMg, 0),
          alcohol_g_at_sleep: round(levels[i]?.alcoholG, 1),
          duration_min: round(s.duration_min, 0),
          deep_min: round(s.deep_min, 0),
          rem_min: round(s.rem_min, 0),
          awake_min: round(s.awake_min, 0),
        }),
      ),
    );
    return JSON.stringify(
      compact({ caffeine_half_life_h: profile.caffeineHalfLifeH, nights: items, note }),
    );
  }

  if (name === "list_saved_meals") {
    const meals = await listSavedMeals();
    return JSON.stringify({
      saved_meals: meals.map((m) =>
        compact({
          id: m.id,
          name: m.name,
          description: m.description,
          nutrients: roundNutrients(m.nutrients),
          saved_from_entry: m.source_entry_id,
          updated: m.updated_at.slice(0, 10),
        }),
      ),
      ...(meals.length === 0
        ? {
            note:
              "Nothing saved yet. A meal is saved from its entry's \"Ask about it\" box (correct it, or paste the official values, and ask to save it), or with save_meal.",
          }
        : {}),
    });
  }

  if (name === "save_meal") {
    const id = typeof args["id"] === "number" ? Math.round(args["id"]) : NaN;
    if (!isFinite(id)) throw new Error("id is required");
    const entry = await getFoodEntry(id);
    if (!entry) throw new Error(`There is no meal #${id}.`);
    const given = typeof args["name"] === "string" ? args["name"].trim() : "";
    const mealName = given || entry.title;
    const saved = await saveMeal({
      name: mealName,
      description: entry.description,
      nutrients: entry.nutrients,
      icon: entry.icon,
      source_entry_id: entry.id,
    });
    return JSON.stringify({
      [saved.updated ? "updated_saved_meal" : "saved_meal"]: {
        id: saved.id,
        name: mealName,
        kcal: round(entry.nutrients.calories ?? null, 0),
      },
    });
  }

  if (name === "edit_saved_meal") {
    const id = typeof args["id"] === "number" ? Math.round(args["id"]) : NaN;
    if (!isFinite(id)) throw new Error("id is required");
    if (args["action"] === "delete") {
      const ok = await deleteSavedMeal(id);
      return JSON.stringify(ok ? { deleted_saved_meal: id } : { error: `No saved meal #${id}.` });
    }
    if (args["action"] === "rename") {
      const newName = typeof args["name"] === "string" ? args["name"].trim() : "";
      if (!newName) throw new Error("name is required to rename");
      const ok = await renameSavedMeal(id, newName);
      return JSON.stringify(ok ? { renamed_saved_meal: id, name: newName } : { error: `No saved meal #${id}.` });
    }
    throw new Error('action must be "rename" or "delete"');
  }

  if (name === "remember") {
    const kind = args["kind"];
    const text = typeof args["text"] === "string" ? args["text"].trim() : "";
    if (!text) throw new Error("text is required");
    if (kind !== "goal" && kind !== "commitment" && kind !== "preference" && kind !== "note") {
      throw new Error('kind must be one of "goal", "commitment", "preference", "note"');
    }
    const followUpOn = followUpDay(args["follow_up_in_days"]);
    // A fresh commitment is open by definition; the others carry no status.
    const id = await addCoachMemory(
      kind,
      text,
      kind === "commitment" ? "open" : null,
      followUpOn,
    );
    return JSON.stringify(
      compact({ remembered: { id, kind, text }, follow_up_on: followUpOn }),
    );
  }

  if (name === "update_memory") {
    const id = typeof args["id"] === "number" ? args["id"] : NaN;
    if (!isFinite(id)) throw new Error("id is required");
    const patch: {
      text?: string;
      status?: "open" | "done" | "dropped";
      followUpOn?: string | null;
    } = {};
    if (typeof args["text"] === "string" && args["text"].trim()) {
      patch.text = args["text"].trim();
    }
    const status = args["status"];
    if (status === "open" || status === "done" || status === "dropped") {
      patch.status = status;
    }
    if (args["clear_follow_up"] === true) {
      patch.followUpOn = null;
    } else {
      const day = followUpDay(args["follow_up_in_days"]);
      if (day) patch.followUpOn = day;
    }
    if (Object.keys(patch).length === 0) throw new Error("nothing to update");
    const ok = await updateCoachMemory(id, patch);
    return JSON.stringify(ok ? { updated: id, ...patch } : { error: `No memory with id ${id}.` });
  }

  if (name === "forget") {
    const id = typeof args["id"] === "number" ? args["id"] : NaN;
    if (!isFinite(id)) throw new Error("id is required");
    await deleteCoachMemory(id);
    return JSON.stringify({ forgot: id });
  }

  if (name === "read_manual") {
    const id = typeof args["id"] === "number" ? args["id"] : NaN;
    if (!isFinite(id)) throw new Error("id is required");
    const m = await getManual(id);
    if (!m) return JSON.stringify({ error: `No manual with id ${id}.` });
    return JSON.stringify({
      id: m.id,
      title: m.title,
      situation: m.situation,
      applies_when: m.applies_when ?? "none",
      last_edited_by: m.edited_by === "you" ? "them" : "you",
      updated_at: m.updated_at,
      body: m.body,
    });
  }

  if (name === "write_manual") {
    const str = (k: string) => (typeof args[k] === "string" ? String(args[k]).trim() : "");
    const draft = {
      title: str("title"),
      situation: str("situation"),
      body: str("body"),
      applies_when: isManualTrigger(args["applies_when"]) ? args["applies_when"] : null,
    };
    if (!draft.title || !draft.situation || !draft.body) {
      throw new Error("title, situation and body are all required");
    }
    if (typeof args["id"] === "number") {
      const id = args["id"];
      // Leaving applies_when out keeps what the manual had, rather than
      // quietly unhooking the fasting manual on an ordinary rewrite.
      if (args["applies_when"] === undefined) {
        draft.applies_when = (await getManual(id))?.applies_when ?? null;
      }
      const ok = await saveManual(id, draft, "coach");
      return JSON.stringify(ok ? { rewrote_manual: id } : { error: `No manual with id ${id}.` });
    }
    const id = await createManual(draft, "coach");
    return JSON.stringify({ created_manual: id });
  }

  if (name === "delete_manual") {
    const id = typeof args["id"] === "number" ? args["id"] : NaN;
    if (!isFinite(id)) throw new Error("id is required");
    await removeManual(id);
    return JSON.stringify({ deleted_manual: id });
  }

  throw new Error(`Unknown tool "${name}"`);
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

export const DB_SCHEMA_DOC = `Tables (SQLite; all timestamps ISO-8601 UTC strings like "2026-07-20T06:30:00.000Z"):
- food_entries(id, eaten_at, day /* local "YYYY-MM-DD" */, tz_offset_min /* minutes east of UTC where it was logged */, title, description, nutrients /* JSON: calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg, … */, fast_ok_note /* why it doesn't break a fast; NULL = it counts as eating */)
- workouts(id, performed_at, day, tz_offset_min, title, description, calories_burned /* kcal; summed per day this is burned_workouts */, duration_min, zone2_min /* explicitly recorded minutes, NULL = unknown */, cardio /* 1 = they switched it on as cardio; its duration_min counts toward the cardio goal */, source /* "Garmin", "Health Connect" or NULL = manual */, external_id)
- sleep_sessions(id, started_at, ended_at, day /* the morning it ended on */, tz_offset_min, duration_min, deep_min, rem_min, light_min, awake_min, source)
- health_metrics(day /* local "YYYY-MM-DD" */, steps, resting_hr, hrv_ms, spo2_pct, weight_kg, vo2_max, calories_total /* kcal, the watch's whole-day burn incl. resting and workouts = burned_total */, updated_at)
- supplements(id, name, dose_amount, dose_unit, nutrients /* JSON per dose */, notes, archived)
- supplement_logs(id, supplement_id, taken_at, day, tz_offset_min, amount /* dose multiplier */) — older supplement intake only. Supplements are now logged as food: food_entries rows with icon = 'supplement' (title like "Fish oil 800 mg", nutrients for the amount taken). Query both when asked about supplements
- fasts(id, started_at, goal_hours, purpose /* their words: what it's for and what they allow themselves; NULL = plain fast */, ended_at /* NULL = active */, start_day, end_day /* NULL while active */, tz_offset_min)
- day_goal_adjustments(day /* local "YYYY-MM-DD" */, delta_kcal /* signed correction the user made to that day's calorie target */, note, updated_at)
- state_logs(id, logged_at, day, tz_offset_min, label /* how they felt: "Bloated", "Depressive thoughts", or their own words */, icon, note /* what else they said about it */) — logged by hand, never estimated; this is the half of a day the numbers don't hold, so use it when they ask why they feel how they feel
- blood_readings(id, measured_at, day, tz_offset_min, kind /* "glucose" | "ketone" */, value /* mmol/L for BOTH kinds; glucose × 18.016 = mg/dL */, note) — finger-prick readings off their meter, read from a photo of its screen. Glucose ÷ ketones taken together (within ~30 min) is the glucose–ketone index (GKI)
- garmin_activities(activity_id, workout_id /* → workouts.id; NULL once they deleted it */, dismissed, linked_by /* "exact" | "time" | "created" */, started_at, duration_sec, type_key, name, distance_m, avg_hr, max_hr, calories, aerobic_te, anaerobic_te /* Training Effect 0–5 */, te_label, training_load, avg_power, max_power, norm_power, avg_cadence, elevation_gain_m, avg_speed_mps, vo2_max, zone_secs /* JSON [z1..z5] seconds */, laps /* JSON array, recent activities only */, summary /* JSON: Garmin's full activity summary */) — direct Garmin Connect sync; join on workout_id for the extras Health Connect doesn't carry
- garmin_days(day, steps, calories_total, calories_active, resting_hr, min_hr, max_hr, stress_avg, stress_max, body_battery_high, body_battery_low, body_battery_charged, body_battery_drained, body_battery_wake, respiration_avg, spo2_avg, spo2_low, floors_up, intensity_min_moderate, intensity_min_vigorous, readiness_score, readiness_level, training_status, acute_load, chronic_load, hrv_last_night, hrv_weekly_avg, hrv_status, vo2_max, weight_kg, sleep_score, sleep_stress, sleep_respiration, sleep_body_battery, sleep_started_at, sleep_ended_at, raw /* JSON: the endpoints' answers */) — Garmin's own daily numbers; prefer query_garmin_wellness
- performance_logs(id, measured_at, day, tz_offset_min, title, note /* e.g. HRV status "Balanced", training status */, photo_path, model_id) — fitness stats read off a watch-app screenshot (usually Garmin Connect)
- performance_stats(id, log_id /* → performance_logs.id */, metric /* "ftp", "vo2max", "vo2max_cycling", "ftp_wkg", "hrv", "hrv_7d", "resting_hr", "max_hr", "lactate_threshold_hr", "lactate_threshold_pace", "lactate_threshold_power", "training_readiness", "endurance_score", "hill_score", "acute_load", "recovery_time", "body_battery", "stress", "fitness_age", "race_5k", "race_10k", "race_half", "race_marathon", or "custom_<slug>" */, label, value /* in unit; paces are SECONDS per km and race predictions SECONDS */, unit) — join on log_id for the day; this is where FTP and lactate threshold live (Health Connect doesn't carry them)
- incomplete_days(day /* local "YYYY-MM-DD" */, updated_at) — days they marked with the Diary's "Incomplete tracking" switch
- entry_notes(id, entry_kind /* "meal" | "workout" | "reading" | "state" | "performance" | "sleep" */, entry_id /* id in food_entries / workouts / blood_readings / state_logs / performance_logs / sleep_sessions */, text, created_at) — notes YOU attached with annotate_entry: context that explains an entry. Join them in whenever you look at readings, states or performance logs
- life_rules(id, text /* a rule for living in their exact words: "I must always do things perfectly" */, alternative /* the rule they practise instead, or NULL */, status /* "kept" | "suggested" (the diary heard it, they haven't confirmed) | "archived" */, created_at, day, tz_offset_min)
- life_rule_logs(id, rule_id, rule_text /* wording at the time */, logged_at, day, tz_offset_min, situation /* what set it off, their words */, belief /* 0-100: how true it felt then; NULL = not rated */, acted_on /* "yes" | "partly" | "no" | NULL */) — the times a rule came up. This is personal work: use it when they ask about their rules, and never bring rules up unprompted or argue with one
- saved_meals(id, name, description, nutrients /* JSON totals for one portion */, icon, source_entry_id /* food_entries.id it was saved from */, created_at, updated_at) — meals kept for reuse with exact numbers; prefer list_saved_meals
- documents(id, document_date /* local day the document refers to */, title, kind, summary, extracted /* JSON array of {name,value,unit,reference,flag} */, status) — prefer query_documents over SQL here
- manuals(id, title, situation, applies_when, body /* markdown */, edited_by, created_at, updated_at) — prefer read_manual / write_manual
Use json_extract(nutrients, '$.protein_g') for nutrient JSON.
ALWAYS group and filter by the \`day\` column, never by date(timestamp): \`day\` is stamped in the timezone the user was actually in, so it stays right when they travel, while a timestamp would be read as UTC.`;

// ---------------------------------------------------------------------------
// The conversation loop
// ---------------------------------------------------------------------------

const MAX_ROUNDS = 10;

/**
 * Everything that happens during a turn, in thread order. `message` and
 * `chart` are user-visible; `reasoning` and `tool` belong to the collapsed
 * activity thread.
 */
export type AssistantEvent =
  | { type: "reasoning"; text: string }
  | { type: "tool"; name: string }
  | { type: "message"; text: string }
  | { type: "chart"; chart: ChartSpec };

export interface AssistantTurnOptions {
  /**
   * Called after every completed round, once `messages` is consistent again.
   * The runner persists there, so an interruption (a suspended WebView, the
   * process being killed) leaves the work done so far in the transcript
   * instead of throwing it away.
   */
  onRound?: () => void;
}

/**
 * Run one user turn: appends to `messages` IN PLACE (assistant/tool messages
 * included) and streams events as they happen. `messages` must already
 * contain the system prompt and the new user message. Resolves once the
 * model stops; rejects if nothing was delivered to the user.
 */
export async function runAssistantTurn(
  messages: ChatMessage[],
  onEvent: (e: AssistantEvent) => void,
  opts: AssistantTurnOptions = {},
): Promise<void> {
  const apiKey = await getSetting(SETTING_KEYS.openrouterApiKey);
  if (!apiKey) throw new Error("Add your OpenRouter API key in Settings first.");
  const model = (await getSetting(SETTING_KEYS.visionModel)) || DEFAULT_VISION_MODEL;

  let delivered = 0;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    // After a delivery an empty completion just means "I'm done" — models
    // routinely end the turn that way after their final send_message call.
    const turn = await chatWithTools(apiKey, model, messages, ASSISTANT_TOOLS, {
      allowEmpty: delivered > 0,
    });
    const content = turn.content?.trim() || "";

    if (turn.tool_calls.length === 0) {
      if (!content) {
        // Nothing to say and nothing to do: a clean end when something was
        // delivered. Don't push an empty assistant message into the
        // transcript — some providers reject it on the next request.
        if (delivered > 0) return;
        throw new Error("The model returned nothing — try rephrasing.");
      }
      messages.push({ role: "assistant", content: turn.content });
      // A model that answers in prose instead of send_message still reaches
      // the user; with prior deliveries it's just trailing reasoning.
      if (delivered === 0) onEvent({ type: "message", text: content });
      else onEvent({ type: "reasoning", text: content });
      opts.onRound?.();
      return;
    }

    if (content) onEvent({ type: "reasoning", text: content });
    messages.push({
      role: "assistant",
      content: turn.content,
      tool_calls: turn.tool_calls,
    });

    for (const call of turn.tool_calls) {
      let result: string;
      try {
        const args = parseToolArgs(call.function.arguments);
        if (call.function.name === "send_message") {
          const text = typeof args["text"] === "string" ? args["text"].trim() : "";
          if (!text) throw new Error("text is required");
          onEvent({ type: "message", text });
          delivered++;
          result = "Delivered.";
        } else if (call.function.name === "send_chart") {
          const chart = sanitizeChart(args);
          onEvent({ type: "chart", chart });
          delivered++;
          result = "Chart delivered.";
        } else {
          onEvent({ type: "tool", name: call.function.name });
          result = await executeAssistantTool(call.function.name, args);
        }
      } catch (e) {
        result = `Error: ${e instanceof Error ? e.message : String(e)}`;
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
    opts.onRound?.();
  }
  if (delivered === 0) {
    throw new Error("The assistant got stuck calling tools — try rephrasing.");
  }
}
