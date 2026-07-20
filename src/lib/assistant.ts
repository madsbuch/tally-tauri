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
  const type = args.type === "line" ? "line" : args.type === "bar" ? "bar" : null;
  if (!type) throw new Error('type must be "bar" or "line"');
  const title = typeof args.title === "string" ? args.title.trim() : "";
  if (!title) throw new Error("title is required");
  const xRaw = Array.isArray(args.x_labels) ? args.x_labels : null;
  if (!xRaw || xRaw.length === 0) throw new Error("x_labels must be a non-empty array");
  if (xRaw.length > MAX_CHART_POINTS) {
    throw new Error(`Too many points (${xRaw.length}) — aggregate to at most ${MAX_CHART_POINTS}`);
  }
  const x_labels = xRaw.map((l) => String(l));
  const sRaw = Array.isArray(args.series) ? args.series : null;
  if (!sRaw || sRaw.length === 0) throw new Error("series must be a non-empty array");
  if (sRaw.length > MAX_CHART_SERIES) {
    throw new Error(`At most ${MAX_CHART_SERIES} series per chart — split into several charts`);
  }
  const series: ChartSeries[] = sRaw.map((s, i) => {
    const o = (s ?? {}) as Record<string, unknown>;
    const name = typeof o.name === "string" && o.name.trim() ? o.name.trim() : `Series ${i + 1}`;
    const vRaw = Array.isArray(o.values) ? o.values : [];
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
  const unit = typeof args.unit === "string" && args.unit.trim() ? args.unit.trim() : undefined;
  return { type, title, unit, x_labels, series };
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
    "COMMUNICATION: the user ONLY sees what you deliver through send_message and send_chart. Plain assistant text is a private reasoning scratchpad — use it to plan, then deliver. Every turn MUST end with at least one send_message.",
    "Use send_chart whenever numbers form a trend or comparison (sleep over a week, calories in vs out, resting HR over a month). Charts are rendered natively — never draw a chart with text, blocks, or ASCII in a message. Keep one unit per chart; send two charts for two units.",
    "",
    "Ground every answer in the data — call query tools first, then deliver. Never guess numbers.",
    "The structured query_* tools cover most questions; use run_sql for aggregates, joins, or longer trends.",
    'Day parameters are LOCAL days ("YYYY-MM-DD"). Resolve relative phrases yourself: "this week" = Monday through today, "last month" = the previous calendar month, and so on.',
    "Missing data is normal (rest days, unsynced watch, features unused) — say so rather than inventing values, and pass null for missing chart points.",
    "",
    DB_SCHEMA_DOC,
    "",
    "Message style: concise markdown in a narrow mobile chat bubble. Lead with the answer in a short sentence, bold the key figures, always include units, skip headers. A short bullet list is fine; put the numbers a chart already shows in the chart, not the text.",
  ].join("\n");
}

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

/**
 * Run one user turn: appends to `messages` IN PLACE (assistant/tool messages
 * included) and streams events as they happen. `messages` must already
 * contain the system prompt and the new user message. Resolves once the
 * model stops; rejects if nothing was delivered to the user.
 */
export async function runAssistantTurn(
  messages: ChatMessage[],
  onEvent: (e: AssistantEvent) => void,
): Promise<void> {
  const apiKey = await getSetting(SETTING_KEYS.openrouterApiKey);
  if (!apiKey) throw new Error("Add your OpenRouter API key in Settings first.");
  const model = (await getSetting(SETTING_KEYS.visionModel)) || DEFAULT_VISION_MODEL;

  let delivered = 0;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const turn = await chatWithTools(apiKey, model, messages, ASSISTANT_TOOLS);
    const content = turn.content?.trim() || "";

    if (turn.tool_calls.length === 0) {
      messages.push({ role: "assistant", content: turn.content });
      if (content) {
        // A model that answers in prose instead of send_message still reaches
        // the user; with prior deliveries it's just trailing reasoning.
        if (delivered === 0) onEvent({ type: "message", text: content });
        else onEvent({ type: "reasoning", text: content });
        return;
      }
      if (delivered > 0) return;
      throw new Error("The model returned nothing — try rephrasing.");
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
        const args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
        if (call.function.name === "send_message") {
          const text = typeof args.text === "string" ? args.text.trim() : "";
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
  }
  if (delivered === 0) {
    throw new Error("The assistant got stuck calling tools — try rephrasing.");
  }
}
