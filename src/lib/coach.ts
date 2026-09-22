/**
 * The coach: what it's pushing for, what it remembers, and what it knows about
 * your week before you say a word.
 *
 * Three pieces, deliberately separate:
 *
 * - **Stance** (settings JSON) is what YOU declared — ranked imperatives, tone,
 *   subjects to never raise. The coach never edits this.
 * - **Memory** (`coach_memory` table) is what IT learned — commitments you
 *   made, preferences you expressed, notes it took. It lives beside the chats
 *   rather than inside one, so deleting a conversation doesn't wipe the
 *   relationship and a new one doesn't start cold.
 * - **Digest** is computed fresh from the diary every turn. Without it the
 *   coach would have to spend tool calls discovering that you exist; with it,
 *   it arrives already knowing how the week went and can spend its tools on
 *   whatever you actually asked.
 */
import {
  getActiveFast,
  getSetting,
  listCoachMemory,
  listFoodEntriesForRange,
  listHealthMetricsForRange,
  listSleepForRange,
  listWorkoutsForRange,
  setSetting,
  todayStr,
} from "./db";
import { CoachStanceSchema, parseJson } from "./schemas";
import { getDayGoal } from "./goals";
import { getStreakInfo } from "./streak";
import { DB_SCHEMA_DOC } from "./assistant";
import { SETTING_KEYS } from "./types";
import type { CoachMemory } from "./types";
import type { z } from "zod";

// ---------------------------------------------------------------------------
// Stance
// ---------------------------------------------------------------------------

export type CoachStance = z.infer<typeof CoachStanceSchema>;
export type CoachTone = CoachStance["tone"];
export type CoachLength = CoachStance["length"];

export const DEFAULT_STANCE: CoachStance = {
  imperatives: [],
  tone: "straight",
  length: "normal",
  avoid: [],
  notes: "",
  language: "",
};

export const TONE_LABELS: Record<CoachTone, string> = {
  gentle: "Gentle",
  straight: "Straight",
  tough: "Tough",
};

export const LENGTH_LABELS: Record<CoachLength, string> = {
  brief: "Brief",
  normal: "Normal",
  thorough: "Thorough",
};

/** How each tone is described to the model. */
const TONE_PROMPT: Record<CoachTone, string> = {
  gentle:
    "Warm and encouraging. Lead with what went well, raise problems as invitations, never pile on.",
  straight:
    "Plain and matter-of-fact. Say what the data shows without softening it and without dramatising it.",
  tough:
    "Direct and demanding. Hold them to what they said they'd do and name a slip as a slip — but never contemptuous, and never about their worth.",
};

const LENGTH_PROMPT: Record<CoachLength, string> = {
  brief: "Two or three sentences. One point only.",
  normal: "A short paragraph, or a few bullets. At most two points.",
  thorough: "You may go into detail and cover several points, still tightly written.",
};

export async function loadCoachStance(): Promise<CoachStance> {
  const raw = await getSetting(SETTING_KEYS.coachStance).catch(() => null);
  if (!raw) return { ...DEFAULT_STANCE };
  try {
    return CoachStanceSchema.parse(parseJson(raw));
  } catch {
    return { ...DEFAULT_STANCE };
  }
}

export async function saveCoachStance(stance: CoachStance): Promise<void> {
  await setSetting(SETTING_KEYS.coachStance, JSON.stringify(stance));
}

// ---------------------------------------------------------------------------
// Digest
// ---------------------------------------------------------------------------

export interface CoachDigest {
  day: string;
  today: {
    kcalIn: number;
    kcalOut: number;
    net: number;
    /** The day's effective calorie target, or null when none is configured. */
    target: number | null;
    proteinG: number;
    itemsLogged: number;
  };
  week: {
    /** Days in the last 7 with at least one meal logged. */
    daysLogged: number;
    avgNet: number | null;
    avgProteinG: number | null;
    workouts: number;
    avgSleepH: number | null;
    /** Nights with sleep data — an average over one night proves nothing. */
    sleepNights: number;
    avgSteps: number | null;
  };
  weight: { latestKg: number; change7dKg: number | null; change30dKg: number | null } | null;
  streak: { current: number; best: number; todayLogged: boolean };
  fast: { hoursElapsed: number; goalHours: number } | null;
}

function shiftDay(day: string, delta: number): string {
  const [y = 0, m = 1, d = 1] = day.split("-").map(Number);
  return todayStr(new Date(y, m - 1, d + delta));
}

function localDayOf(iso: string): string {
  return todayStr(new Date(iso));
}

const round = (n: number, dp = 0): number => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

const avg = (xs: number[]): number | null =>
  xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * A compact, deterministic read of the diary. Kept narrow on purpose: these
 * same numbers have to be reproducible in Rust for the scheduled check-in, so
 * every field here is a plain sum or average, never a nutrient-model judgement.
 */
export async function buildCoachDigest(day = todayStr()): Promise<CoachDigest> {
  const weekStart = shiftDay(day, -6);
  const monthStart = shiftDay(day, -30);

  const [entries, workouts, sleep, metrics, streak, fast, goal] = await Promise.all([
    listFoodEntriesForRange(weekStart, day),
    listWorkoutsForRange(weekStart, day),
    listSleepForRange(weekStart, day).catch(() => []),
    listHealthMetricsForRange(monthStart, day).catch(() => []),
    getStreakInfo().catch(() => null),
    getActiveFast().catch(() => null),
    getDayGoal(day).catch(() => null),
  ]);

  const todayEntries = entries.filter((e) => localDayOf(e.eaten_at) === day);
  const todayWorkouts = workouts.filter((w) => localDayOf(w.performed_at) === day);
  const kcalIn = todayEntries.reduce((a, e) => a + (e.nutrients.calories ?? 0), 0);
  const kcalOut = todayWorkouts.reduce((a, w) => a + w.calories_burned, 0);
  const proteinG = todayEntries.reduce((a, e) => a + (e.nutrients.protein_g ?? 0), 0);

  // Per-day rollups over the week, counting only days with food logged — an
  // unlogged day would otherwise drag every average toward zero.
  const inByDay = new Map<string, number>();
  const proteinByDay = new Map<string, number>();
  for (const e of entries) {
    const d = localDayOf(e.eaten_at);
    inByDay.set(d, (inByDay.get(d) ?? 0) + (e.nutrients.calories ?? 0));
    proteinByDay.set(d, (proteinByDay.get(d) ?? 0) + (e.nutrients.protein_g ?? 0));
  }
  const outByDay = new Map<string, number>();
  for (const w of workouts) {
    const d = localDayOf(w.performed_at);
    outByDay.set(d, (outByDay.get(d) ?? 0) + w.calories_burned);
  }
  const loggedDays = [...inByDay.keys()];
  const nets = loggedDays.map((d) => (inByDay.get(d) ?? 0) - (outByDay.get(d) ?? 0));
  const proteins = loggedDays.map((d) => proteinByDay.get(d) ?? 0);

  // A night belongs to the morning it ended; several sessions add up.
  const sleepByDay = new Map<string, number>();
  for (const s of sleep) {
    const d = localDayOf(s.ended_at);
    sleepByDay.set(d, (sleepByDay.get(d) ?? 0) + s.duration_min);
  }
  const stepDays = metrics
    .filter((m) => m.day >= weekStart && m.steps != null)
    .map((m) => m.steps as number);

  const weights = metrics
    .filter((m) => m.weight_kg != null)
    .map((m) => ({ day: m.day, kg: m.weight_kg as number }))
    .sort((a, b) => (a.day < b.day ? -1 : 1));
  const latest = weights[weights.length - 1];
  const at = (from: string): number | null => {
    // Nearest reading on or after `from` — the baseline to compare against.
    const hit = weights.find((w) => w.day >= from);
    return hit ? hit.kg : null;
  };
  const base7 = at(weekStart);
  const base30 = at(monthStart);

  return {
    day,
    today: {
      kcalIn: round(kcalIn),
      kcalOut: round(kcalOut),
      net: round(kcalIn - kcalOut),
      target: goal ? round(goal.target) : null,
      proteinG: round(proteinG),
      itemsLogged: todayEntries.length + todayWorkouts.length,
    },
    week: {
      daysLogged: loggedDays.length,
      avgNet: avg(nets) == null ? null : round(avg(nets) as number),
      avgProteinG: avg(proteins) == null ? null : round(avg(proteins) as number),
      workouts: workouts.length,
      avgSleepH:
        sleepByDay.size === 0
          ? null
          : round((avg([...sleepByDay.values()]) as number) / 60, 1),
      sleepNights: sleepByDay.size,
      avgSteps: stepDays.length === 0 ? null : round(avg(stepDays) as number),
    },
    weight: latest
      ? {
          latestKg: round(latest.kg, 1),
          change7dKg: base7 == null ? null : round(latest.kg - base7, 1),
          change30dKg: base30 == null ? null : round(latest.kg - base30, 1),
        }
      : null,
    streak: streak
      ? { current: streak.current, best: streak.best, todayLogged: streak.todayLogged }
      : { current: 0, best: 0, todayLogged: false },
    fast: fast
      ? {
          hoursElapsed: round(
            (Date.now() - new Date(fast.started_at).getTime()) / 3_600_000,
            1,
          ),
          goalHours: fast.goal_hours,
        }
      : null,
  };
}

const na = (v: number | null, unit = ""): string =>
  v == null ? "no data" : `${v}${unit}`;

/** The digest as prompt text. Terse — it's read by a model, not a person. */
export function renderCoachDigest(d: CoachDigest): string {
  const lines = [
    `Today (${d.day}): ${d.today.kcalIn} kcal in, ${d.today.kcalOut} burned, net ${d.today.net}` +
      (d.today.target != null ? ` against a ${d.today.target} kcal target` : " (no target set)") +
      `; ${d.today.proteinG} g protein; ${d.today.itemsLogged} items logged.`,
    `Last 7 days: ${d.week.daysLogged}/7 days with food logged, avg net ${na(d.week.avgNet, " kcal")}, ` +
      `avg protein ${na(d.week.avgProteinG, " g")}, ${d.week.workouts} workouts, ` +
      `avg sleep ${na(d.week.avgSleepH, " h")}, avg steps ${na(d.week.avgSteps)}.`,
  ];
  if (d.weight) {
    lines.push(
      `Weight: ${d.weight.latestKg} kg` +
        (d.weight.change7dKg != null ? `, ${d.weight.change7dKg >= 0 ? "+" : ""}${d.weight.change7dKg} kg over 7 days` : "") +
        (d.weight.change30dKg != null ? `, ${d.weight.change30dKg >= 0 ? "+" : ""}${d.weight.change30dKg} kg over 30 days` : "") +
        ".",
    );
  }
  lines.push(
    `Logging streak: ${d.streak.current} days (best ${d.streak.best}); today ${d.streak.todayLogged ? "is" : "is not"} logged yet.`,
  );
  if (d.fast) {
    lines.push(`Fasting right now: ${d.fast.hoursElapsed} h of a ${d.fast.goalHours} h goal.`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

function renderStance(s: CoachStance): string {
  const lines: string[] = [];
  if (s.imperatives.length > 0) {
    lines.push(
      "What they want from you, in their order of priority — the first one outranks the rest, and when two pull against each other, it wins:",
      ...s.imperatives.map((g, i) => `  ${i + 1}. ${g}`),
    );
  } else {
    lines.push(
      "They haven't set any priorities yet. Work out what matters from their data and their answers, and early on, ask.",
    );
  }
  lines.push(`Tone: ${TONE_PROMPT[s.tone]}`);
  lines.push(`Length: ${LENGTH_PROMPT[s.length]}`);
  if (s.language) lines.push(`Always answer in ${s.language}.`);
  if (s.avoid.length > 0) {
    lines.push(
      `NEVER raise these subjects, not even in passing, however relevant the data looks: ${s.avoid.join("; ")}.`,
    );
  }
  if (s.notes) lines.push(`In their own words: ${s.notes}`);
  return lines.join("\n");
}

function renderMemory(memory: CoachMemory[]): string {
  if (memory.length === 0) {
    return "You haven't recorded anything about them yet. When something durable comes up — a goal, something they commit to, a preference — write it down with `remember`.";
  }
  const byKind = (kind: CoachMemory["kind"]) => memory.filter((m) => m.kind === kind);
  const lines: string[] = [];
  const section = (title: string, rows: CoachMemory[], withStatus = false) => {
    if (rows.length === 0) return;
    lines.push(`${title}:`);
    for (const r of rows) {
      lines.push(`  [${r.id}]${withStatus && r.status ? ` (${r.status})` : ""} ${r.text}`);
    }
  };
  section("Goals you've recorded", byKind("goal"));
  section("Commitments they made", byKind("commitment"), true);
  section("Preferences", byKind("preference"));
  section("Your notes", byKind("note"));
  return lines.join("\n");
}

function tzOffsetLabel(d: Date): string {
  const mins = -d.getTimezoneOffset();
  const sign = mins >= 0 ? "+" : "-";
  const abs = Math.abs(mins);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

/**
 * The lines that don't bend, whatever stance is configured. This is a food and
 * weight app: a coach that pushes hard here can do real damage, and one that
 * moralises gets muted, which comes to the same thing.
 */
const GUARDRAILS = [
  "Never shame, moralise, or imply anything about their worth. A bad week is data, not a verdict.",
  "Never propose eating less than the target they set, and never suggest skipping meals to make numbers work. If their own target looks too aggressive for their weight and activity, say so plainly instead of helping them chase it.",
  "If they show signs of a disordered relationship with food or exercise — punishing themselves, hiding meals, exercising to 'earn' food — drop the coaching, say what you've noticed in one gentle sentence, and suggest talking to a doctor or dietitian.",
  "Praise effort that actually happened; don't invent it. Empty encouragement is worse than silence.",
  "You are not a clinician. Flag anything medical for a professional rather than advising on it.",
];

export interface CoachPromptOptions {
  /** Extra framing for a proactive check-in; absent for a normal chat. */
  occasion?: string;
}

/**
 * The full coach system prompt: who it is, what it's pushing for, what it
 * remembers, and how the week has actually gone.
 */
export async function buildCoachSystemPrompt(
  opts: CoachPromptOptions = {},
): Promise<string> {
  const [stance, memory, digest] = await Promise.all([
    loadCoachStance(),
    listCoachMemory().catch(() => [] as CoachMemory[]),
    buildCoachDigest(),
  ]);
  const now = new Date();
  const weekday = now.toLocaleDateString("en-US", { weekday: "long" });
  const local = `${todayStr(now)} ${String(now.getHours()).padStart(2, "0")}:${String(
    now.getMinutes(),
  ).padStart(2, "0")}`;

  return [
    "You are Tally's coach. Tally is a local-first tracker holding this person's food diary, workouts, sleep, daily wellness metrics (synced from their Garmin watch via Health Connect), supplements, and fasting history. You have read access to all of it.",
    "You are a coach, not a search engine: you have a view on how their week is going and you say it. But they also just ask things sometimes — when they do, answer the question rather than turning it into a lesson.",
    `Current local date & time: ${weekday} ${local} (${tzOffsetLabel(now)}).`,
    "",
    "## Your stance",
    renderStance(stance),
    "",
    "## What you know about them",
    renderMemory(memory),
    "Keep this current as you go: `remember` something durable the moment it comes up, `update_memory` when a commitment is met or abandoned, `forget` what turned out to be wrong. Never record anything they told you to drop.",
    "",
    "## Where they stand right now",
    renderCoachDigest(digest),
    "These numbers are already yours — don't spend a tool call re-fetching them. Use the query tools for anything deeper: specific days, longer trends, individual meals.",
    ...(opts.occasion ? ["", `## This check-in`, opts.occasion] : []),
    "",
    "## Rules that don't bend",
    ...GUARDRAILS.map((g) => `- ${g}`),
    "",
    "## Delivering",
    "COMMUNICATION: the user ONLY sees what you deliver through send_message and send_chart. Plain assistant text is a private scratchpad — use it to think, then deliver. Every turn MUST end with at least one send_message.",
    "Use send_chart whenever numbers form a trend or comparison. Charts are rendered natively — never draw one with text, blocks, or ASCII. One unit per chart; send two charts for two units.",
    "Ground everything in the data. Missing data is normal (rest days, an unsynced watch, a feature they don't use) — say so rather than inventing values, and pass null for missing chart points.",
    "Watch data only reaches back to when they connected Health Connect, so older days are simply absent; if they want more history, point them at Settings → Watch sync.",
    'Day parameters are LOCAL days ("YYYY-MM-DD"). Resolve relative phrases yourself.',
    "The structured query_* tools cover most questions; run_sql handles aggregates, joins and longer trends.",
    "search_packaged_food looks up branded products in the public Open Food Facts database — use it for product facts or healthier-alternative comparisons. The logged diary entries remain the source of truth for what was actually eaten.",
    "",
    DB_SCHEMA_DOC,
    "Say one useful thing rather than five true ones. If there's nothing worth raising, don't manufacture a concern.",
    "Message style: concise markdown in a narrow mobile chat bubble. Lead with the point, bold the key figures, always include units, skip headers. Put numbers a chart already shows in the chart, not the text.",
  ].join("\n");
}
