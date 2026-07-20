/**
 * Data assistant — a conversational agent with read-only tool access to
 * everything Tally stores: meals, workouts (incl. Garmin), sleep, daily
 * wellness metrics, supplements, and fasts. Structured query tools cover the
 * common cases; a guarded SELECT-only SQL tool handles everything else.
 */
import {
  getDb,
  getSetting,
  listFoodEntriesForRange,
  listHealthMetricsForRange,
  listRecentFasts,
  listSleepForRange,
  listSupplementLogsForRange,
  listSupplements,
  listWorkoutsForRange,
  getActiveFast,
  todayStr,
} from "./db";
import { chatWithTools } from "./openrouter";
import type { ChatMessage, ToolDef } from "./openrouter";
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
        "Exercise sessions in a day range — manual entries and Garmin/Health Connect synced ones (calories burned, duration, distance/HR in the description).",
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
        "Daily wellness metrics (from Garmin/Health Connect) per local day: steps, resting heart rate, HRV (RMSSD ms), blood oxygen %, weight kg, VO2 max, total calories burned.",
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
        "The currently active fast (if any) and recently completed fasts with goal and actual duration.",
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
];

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

function dayArgs(args: Record<string, unknown>): { start: string; end: string } {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  const start = typeof args.start_day === "string" ? args.start_day : "";
  const end = typeof args.end_day === "string" ? args.end_day : "";
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

export async function executeAssistantTool(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  if (name === "query_meals") {
    const { start, end } = dayArgs(args);
    const meals = await listFoodEntriesForRange(start, end);
    const { items, note } = capList(
      meals.map((m) =>
        compact({
          id: m.id,
          eaten_at: m.eaten_at,
          title: m.title,
          description: m.description,
          nutrients: roundNutrients(m.nutrients),
        }),
      ),
    );
    return JSON.stringify(compact({ meals: items, note }));
  }

  if (name === "query_workouts") {
    const { start, end } = dayArgs(args);
    const workouts = await listWorkoutsForRange(start, end);
    const { items, note } = capList(
      workouts.map((w) =>
        compact({
          id: w.id,
          performed_at: w.performed_at,
          title: w.title,
          description: w.description,
          calories_burned: round(w.calories_burned, 0),
          duration_min: round(w.duration_min, 0),
          source: w.source ?? "manual",
        }),
      ),
    );
    return JSON.stringify(compact({ workouts: items, note }));
  }

  if (name === "query_sleep") {
    const { start, end } = dayArgs(args);
    const sessions = await listSleepForRange(start, end);
    const { items, note } = capList(
      sessions.map((s) =>
        compact({
          started_at: s.started_at,
          ended_at: s.ended_at,
          duration_min: round(s.duration_min, 0),
          deep_min: round(s.deep_min, 0),
          rem_min: round(s.rem_min, 0),
          light_min: round(s.light_min, 0),
          awake_min: round(s.awake_min, 0),
          source: s.source,
        }),
      ),
    );
    return JSON.stringify(compact({ sleep_sessions: items, note }));
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
          compact({ taken_at: l.taken_at, name: l.name, doses: round(l.amount) }),
        ),
      ).items,
    });
  }

  if (name === "query_fasts") {
    const limit =
      typeof args.limit === "number" && isFinite(args.limit)
        ? Math.max(1, Math.min(100, Math.round(args.limit)))
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
              elapsed_hours: hours(active.started_at, new Date().toISOString()),
            }
          : null,
        completed_fasts: recent.map((f) =>
          compact({
            started_at: f.started_at,
            ended_at: f.ended_at,
            goal_hours: f.goal_hours,
            actual_hours: f.ended_at ? hours(f.started_at, f.ended_at) : null,
          }),
        ),
      }),
    );
  }

  if (name === "run_sql") {
    if (typeof args.sql !== "string" || !args.sql.trim()) {
      throw new Error("sql is required");
    }
    return runSql(args.sql);
  }

  throw new Error(`Unknown tool "${name}"`);
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const DB_SCHEMA_DOC = `Tables (SQLite; all timestamps ISO-8601 UTC strings like "2026-07-20T06:30:00.000Z"):
- food_entries(id, eaten_at, title, description, nutrients /* JSON: calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg, … */)
- workouts(id, performed_at, title, description, calories_burned, duration_min, source /* "Garmin", "Health Connect" or NULL = manual */, external_id)
- sleep_sessions(id, started_at, ended_at, duration_min, deep_min, rem_min, light_min, awake_min, source)
- health_metrics(day /* local "YYYY-MM-DD" */, steps, resting_hr, hrv_ms, spo2_pct, weight_kg, vo2_max, calories_total, updated_at)
- supplements(id, name, dose_amount, dose_unit, nutrients /* JSON per dose */, notes, archived)
- supplement_logs(id, supplement_id, taken_at, amount /* dose multiplier */)
- fasts(id, started_at, goal_hours, ended_at /* NULL = active */)
Use json_extract(nutrients, '$.protein_g') for nutrient JSON. Local day of a UTC timestamp: the user's timezone offset is given above.`;

function tzOffsetLabel(d: Date): string {
  const mins = -d.getTimezoneOffset();
  const sign = mins >= 0 ? "+" : "-";
  const abs = Math.abs(mins);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

export function buildAssistantSystemPrompt(): string {
  const now = new Date();
  const weekday = now.toLocaleDateString("en-US", { weekday: "long" });
  const local = `${todayStr(now)} ${String(now.getHours()).padStart(2, "0")}:${String(
    now.getMinutes(),
  ).padStart(2, "0")}`;
  return [
    "You are Tally's health assistant. Tally is a local-first tracker holding the user's food diary, workouts, sleep, daily wellness metrics (synced from their Garmin watch via Health Connect), supplements, and fasting history.",
    `Current local date & time: ${weekday} ${local} (${tzOffsetLabel(now)}).`,
    "",
    "Ground every answer in the data — call tools first, then answer. Never guess numbers.",
    "The structured query_* tools cover most questions; use run_sql for aggregates, joins, or longer trends.",
    'Day parameters are LOCAL days ("YYYY-MM-DD"). Resolve relative phrases yourself: "this week" = Monday through today, "last month" = the previous calendar month, and so on.',
    "Missing data is normal (rest days, unsynced watch, features unused) — say so rather than inventing values.",
    "",
    DB_SCHEMA_DOC,
    "",
    "Style: answer in markdown, rendered in a narrow mobile chat bubble. Lead with the answer in a short sentence, then use compact bullet lists or a small table when they make numbers clearer. Bold the key figures, always include units, and skip headers. Be concise; mention notable patterns or caveats only when genuinely useful.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// The conversation loop
// ---------------------------------------------------------------------------

const MAX_ROUNDS = 8;

export interface AssistantTurnResult {
  /** Final plain-text reply. */
  reply: string;
  /** Names of tools called while producing the reply (for the UI). */
  toolsUsed: string[];
}

/**
 * Run one user turn: appends to `messages` IN PLACE (assistant/tool messages
 * included) and returns the final text reply. `messages` must already contain
 * the system prompt and the new user message.
 */
export async function runAssistantTurn(
  messages: ChatMessage[],
  onToolCall?: (name: string) => void,
): Promise<AssistantTurnResult> {
  const apiKey = await getSetting(SETTING_KEYS.openrouterApiKey);
  if (!apiKey) throw new Error("Add your OpenRouter API key in Settings first.");
  const model = (await getSetting(SETTING_KEYS.visionModel)) || DEFAULT_VISION_MODEL;

  const toolsUsed: string[] = [];
  for (let round = 0; round < MAX_ROUNDS; round++) {
    // Last round: no tools, forcing a final text answer.
    const tools = round < MAX_ROUNDS - 1 ? ASSISTANT_TOOLS : [];
    const turn = await chatWithTools(apiKey, model, messages, tools);
    if (turn.tool_calls.length === 0) {
      const reply = turn.content?.trim() || "I couldn't find an answer to that.";
      messages.push({ role: "assistant", content: reply });
      return { reply, toolsUsed };
    }
    messages.push({
      role: "assistant",
      content: turn.content,
      tool_calls: turn.tool_calls,
    });
    for (const call of turn.tool_calls) {
      if (!toolsUsed.includes(call.function.name)) toolsUsed.push(call.function.name);
      onToolCall?.(call.function.name);
      let result: string;
      try {
        const args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
        result = await executeAssistantTool(call.function.name, args);
      } catch (e) {
        result = `Error: ${e instanceof Error ? e.message : String(e)}`;
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
  }
  throw new Error("The assistant got stuck calling tools — try rephrasing.");
}
