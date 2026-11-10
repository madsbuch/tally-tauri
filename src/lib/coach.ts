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
 * - **Manuals** (`manuals` table) are what it worked out about one situation
 *   — a fast, a trip — written up as a page you can read. Only an index rides
 *   in the prompt; a page is read when it applies (see lib/manuals.ts).
 * - **Digest** is computed fresh from the diary every turn. Without it the
 *   coach would have to spend tool calls discovering that you exist; with it,
 *   it arrives already knowing how the week went and can spend its tools on
 *   whatever you actually asked.
 */
import {
  getActiveFast,
  getSetting,
  listCoachMemory,
  listDocuments,
  getManualFor,
  listManuals,
  listExperiments,
  listTrials,
  listFoodEntriesForRange,
  listBloodReadingsForRange,
  listIncompleteDays,
  listPerformanceLogsForRange,
  listHealthMetricsForRange,
  listSleepForRange,
  listStateLogsForRange,
  listWorkoutsForRange,
  setSetting,
  todayStr,
} from "./db";
import { CoachStanceSchema, parseJson } from "./schemas";
import { gki } from "./readings";
import { formatStat, orderStats } from "./performance";
import { dayOf, offsetLabel, offsetMinOf, timeOf } from "./daystamp";
import { cardioMinutes, getCardioTarget, getDayGoal, getProteinTarget } from "./goals";
import { getStreakInfo } from "./streak";
import { DB_SCHEMA_DOC } from "./assistant";
import { DEFAULT_CARDIO_TARGET_MIN, DEFAULT_PROTEIN_TARGET_G, SETTING_KEYS } from "./types";
import type { CoachMemory, Experiment, ExperimentTrial, LibraryDocument, Manual } from "./types";
import { armCounts, armName, armOf, isReadyToConclude, isUnrated, nextArm, ratingMeasures } from "./experiments";
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
    /** Daily protein goal in grams. */
    proteinTarget: number;
    itemsLogged: number;
    /** They marked today as incompletely tracked. */
    incomplete: boolean;
  };
  week: {
    /** Days in the last 7 with at least one meal logged. */
    daysLogged: number;
    /** Days in the last 7 they marked as incompletely tracked, oldest first. */
    incompleteDays: string[];
    avgNet: number | null;
    avgProteinG: number | null;
    workouts: number;
    /** Minutes of workouts switched on as cardio, over the 7 days ending today (today included). */
    cardioMin: number;
    /** The cardio goal, minutes per 7 days. */
    cardioTarget: number;
    avgSleepH: number | null;
    /** Nights with sleep data — an average over one night proves nothing. */
    sleepNights: number;
    avgSteps: number | null;
  };
  weight: { latestKg: number; change7dKg: number | null; change30dKg: number | null } | null;
  streak: { current: number; best: number; todayLogged: boolean };
  fast: { hoursElapsed: number; goalHours: number; purpose: string | null } | null;
  /**
   * How they said they felt — the half of a day the numbers don't hold.
   * Today's with the time and whatever they wrote, and the week as a tally,
   * which is what turns one bad afternoon into something worth mentioning.
   */
  states: {
    today: { label: string; time: string; note: string | null }[];
    week: { label: string; count: number }[];
  };
  /**
   * Meter readings, mmol/L. Today's in order; the week as averages, which is
   * what a ketogenic diet is steered by — a single strip swings with the hour.
   */
  readings: {
    today: { kind: "glucose" | "ketone"; value: number; time: string }[];
    week: { avgGlucose: number | null; avgKetone: number | null; avgGki: number | null; count: number };
  };
  /**
   * The latest of each performance stat from the last 90 days (FTP, VO₂ max,
   * HRV…), already formatted, with the day it was read. Fitness moves slowly,
   * so the newest value is what matters, and its age says how stale it is.
   */
  performance: { label: string; value: string; day: string }[];
}

function shiftDay(day: string, delta: number): string {
  const [y = 0, m = 1, d = 1] = day.split("-").map(Number);
  return todayStr(new Date(y, m - 1, d + delta));
}

/** The day a row was stamped with when written (see lib/daystamp.ts). */
function dayOfRow(
  row: { day: string | null; tz_offset_min: number | null },
  iso: string,
): string {
  return row.day ?? dayOf(iso, row.tz_offset_min);
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

  const [entries, workouts, sleep, metrics, streak, fast, goal, proteinTarget, cardioTarget, stateLogs, readings, perfLogs, incomplete] =
    await Promise.all([
      listFoodEntriesForRange(weekStart, day),
      listWorkoutsForRange(weekStart, day),
      listSleepForRange(weekStart, day).catch(() => []),
      listHealthMetricsForRange(monthStart, day).catch(() => []),
      getStreakInfo().catch(() => null),
      getActiveFast().catch(() => null),
      getDayGoal(day).catch(() => null),
      getProteinTarget().catch(() => DEFAULT_PROTEIN_TARGET_G),
      getCardioTarget().catch(() => DEFAULT_CARDIO_TARGET_MIN),
      listStateLogsForRange(weekStart, day).catch(() => []),
      listBloodReadingsForRange(weekStart, day).catch(() => []),
      listPerformanceLogsForRange(shiftDay(day, -89), day).catch(() => []),
      listIncompleteDays(weekStart, day).catch(() => new Set<string>()),
    ]);

  // Logs come newest first, so the first sighting of a metric is its latest.
  const latestStats = new Map<string, { label: string; value: string; day: string }>();
  for (const log of perfLogs) {
    for (const st of orderStats(log.stats)) {
      if (!latestStats.has(st.metric)) {
        latestStats.set(st.metric, { label: st.label, value: formatStat(st), day: log.day });
      }
    }
  }

  const todayReadings = readings
    .filter((r) => r.day === day)
    .map((r) => ({ kind: r.kind, value: round(r.value, 1), time: timeOf(r.measured_at, r.tz_offset_min) }))
    .reverse();
  const glucoses = readings.filter((r) => r.kind === "glucose");
  const ketones = readings.filter((r) => r.kind === "ketone");
  // GKI only from strips read together: each ketone with the nearest glucose
  // within half an hour.
  const gkis: number[] = [];
  for (const k of ketones) {
    const at = new Date(k.measured_at).getTime();
    const g = glucoses
      .map((x) => ({ x, gap: Math.abs(new Date(x.measured_at).getTime() - at) }))
      .filter((p) => p.gap <= 30 * 60_000)
      .sort((a, b) => a.gap - b.gap)[0];
    const i = g ? gki(g.x.value, k.value) : null;
    if (i !== null) gkis.push(i);
  }
  const avgOf = (xs: number[]): number | null => {
    const a = avg(xs);
    return a == null ? null : round(a, 1);
  };

  // Chronological for today (a day reads forwards), and tallied for the week.
  // Grouped case-insensitively: a chip writes "Bloated" and the capture agent
  // may write "bloated", and they are plainly the same thing.
  const todayStates = stateLogs
    .filter((st) => st.day === day)
    .map((st) => ({
      label: st.label,
      time: timeOf(st.logged_at, st.tz_offset_min),
      note: st.note,
    }))
    .reverse();
  const stateCounts = new Map<string, { label: string; count: number }>();
  for (const st of stateLogs) {
    const k = st.label.trim().toLowerCase();
    const seen = stateCounts.get(k);
    if (seen) seen.count++;
    else stateCounts.set(k, { label: st.label, count: 1 });
  }
  const weekStates = [...stateCounts.values()].sort((a, b) => b.count - a.count);

  const todayEntries = entries.filter((e) => dayOfRow(e, e.eaten_at) === day);
  const todayWorkouts = workouts.filter((w) => dayOfRow(w, w.performed_at) === day);
  const kcalIn = todayEntries.reduce((a, e) => a + (e.nutrients.calories ?? 0), 0);
  const kcalOut = todayWorkouts.reduce((a, w) => a + w.calories_burned, 0);
  const proteinG = todayEntries.reduce((a, e) => a + (e.nutrients.protein_g ?? 0), 0);

  // Per-day rollups over the week, counting only days with food logged — an
  // unlogged day would otherwise drag every average toward zero.
  const inByDay = new Map<string, number>();
  const proteinByDay = new Map<string, number>();
  for (const e of entries) {
    const d = dayOfRow(e, e.eaten_at);
    inByDay.set(d, (inByDay.get(d) ?? 0) + (e.nutrients.calories ?? 0));
    proteinByDay.set(d, (proteinByDay.get(d) ?? 0) + (e.nutrients.protein_g ?? 0));
  }
  const outByDay = new Map<string, number>();
  for (const w of workouts) {
    const d = dayOfRow(w, w.performed_at);
    outByDay.set(d, (outByDay.get(d) ?? 0) + w.calories_burned);
  }
  const loggedDays = [...inByDay.keys()];
  const nets = loggedDays.map((d) => (inByDay.get(d) ?? 0) - (outByDay.get(d) ?? 0));
  const proteins = loggedDays.map((d) => proteinByDay.get(d) ?? 0);

  // A night belongs to the morning it ended; several sessions add up.
  const sleepByDay = new Map<string, number>();
  for (const s of sleep) {
    const d = dayOfRow(s, s.ended_at);
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
      proteinTarget: round(proteinTarget),
      itemsLogged: todayEntries.length + todayWorkouts.length,
      incomplete: incomplete.has(day),
    },
    week: {
      daysLogged: loggedDays.length,
      incompleteDays: [...incomplete].sort(),
      avgNet: avg(nets) == null ? null : round(avg(nets) as number),
      avgProteinG: avg(proteins) == null ? null : round(avg(proteins) as number),
      workouts: workouts.length,
      cardioMin: round(cardioMinutes(workouts)),
      cardioTarget: round(cardioTarget),
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
          purpose: fast.purpose,
        }
      : null,
    states: { today: todayStates, week: weekStates },
    readings: {
      today: todayReadings,
      week: {
        avgGlucose: avgOf(glucoses.map((r) => r.value)),
        avgKetone: avgOf(ketones.map((r) => r.value)),
        avgGki: avgOf(gkis),
        count: readings.length,
      },
    },
    performance: [...latestStats.values()],
  };
}

const na = (v: number | null, unit = ""): string =>
  v == null ? "no data" : `${v}${unit}`;

/** The digest as prompt text. Terse — it's read by a model, not a person. */
export function renderCoachDigest(d: CoachDigest): string {
  const lines = [
    `Today (${d.day}): ${d.today.kcalIn} kcal in, ${d.today.kcalOut} burned, net ${d.today.net}` +
      (d.today.target != null ? ` against a ${d.today.target} kcal target` : " (no target set)") +
      `; ${d.today.proteinG} g protein against a ${d.today.proteinTarget} g daily goal; ${d.today.itemsLogged} items logged.`,
    `Last 7 days: ${d.week.daysLogged}/7 days with food logged, avg net ${na(d.week.avgNet, " kcal")}, ` +
      `avg protein ${na(d.week.avgProteinG, " g")} (goal ${d.today.proteinTarget} g/day), ${d.week.workouts} workouts, ` +
      `avg sleep ${na(d.week.avgSleepH, " h")}, avg steps ${na(d.week.avgSteps)}.`,
    ...(d.week.incompleteDays.length > 0
      ? [`Days they marked as incomplete tracking (last 7 days): ${d.week.incompleteDays.join(", ")}.`]
      : []),
    `Cardio, last 7 days incl. today: ${d.week.cardioMin} of a ${d.week.cardioTarget} min goal per 7 days ` +
      "(workouts they switched on as cardio, full duration).",
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
    lines.push(
      `Fasting right now: ${d.fast.hoursElapsed} h of a ${d.fast.goalHours} h goal` +
        (d.fast.purpose ? ` — purpose: "${d.fast.purpose}".` : "."),
    );
  }
  if (d.states.today.length > 0) {
    lines.push(
      "Felt today: " +
        d.states.today
          .map((st) => `${st.label} ${st.time}` + (st.note ? ` — ${st.note}` : ""))
          .join("; ") +
        ".",
    );
  }
  if (d.states.week.length > 0) {
    lines.push(
      "States logged in the last 7 days: " +
        d.states.week.map((st) => `${st.label} ×${st.count}`).join(", ") +
        ".",
    );
  }
  if (d.readings.today.length > 0) {
    lines.push(
      "Meter today (mmol/L): " +
        d.readings.today.map((r) => `${r.kind} ${r.value} ${r.time}`).join("; ") +
        ".",
    );
  }
  if (d.readings.week.count > 0) {
    const w = d.readings.week;
    lines.push(
      `Meter, last 7 days (${w.count} readings, mmol/L): avg glucose ${na(w.avgGlucose)}, ` +
        `avg ketones ${na(w.avgKetone)}, avg GKI ${na(w.avgGki)}.`,
    );
  }
  if (d.performance.length > 0) {
    lines.push(
      "Latest performance stats (last 90 days): " +
        d.performance.map((p) => `${p.label} ${p.value} (${p.day})`).join("; ") +
        ".",
    );
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

function renderMemory(memory: CoachMemory[], today: string): string {
  if (memory.length === 0) {
    return "You haven't recorded anything about them yet. When something durable comes up — a goal, something they commit to, a preference, something they mention that's worth revisiting — write it down with `remember`.";
  }
  const byKind = (kind: CoachMemory["kind"]) => memory.filter((m) => m.kind === kind);
  const lines: string[] = [];
  const section = (title: string, rows: CoachMemory[], withStatus = false) => {
    if (rows.length === 0) return;
    lines.push(`${title}:`);
    for (const r of rows) {
      const due =
        r.follow_up_on == null
          ? ""
          : r.follow_up_on <= today
            ? " — FOLLOW UP NOW"
            : ` — follow up on ${r.follow_up_on}`;
      lines.push(
        `  [${r.id}]${withStatus && r.status ? ` (${r.status})` : ""} ${r.text}${due}`,
      );
    }
  };
  section("Goals you've recorded", byKind("goal"));
  section("Commitments they made", byKind("commitment"), true);
  section("Preferences", byKind("preference"));
  section("Your notes", byKind("note"));
  return lines.join("\n");
}

/** Memories whose follow-up has come due — the count the Coach tab shows. */
export function dueFollowUpCount(memory: CoachMemory[], today = todayStr()): number {
  return memory.filter((m) => m.follow_up_on != null && m.follow_up_on <= today).length;
}

/**
 * An index of the manuals: titles and when each applies, so the coach knows
 * which page to open without carrying every page in every prompt.
 */
function renderManuals(manuals: Manual[]): string {
  if (manuals.length === 0) {
    return "None yet. When you learn what works for them in a recurring situation — how they fast best, how they travel, what gets them through a bad week — write it up with `write_manual`.";
  }
  const lines = ["Read one with `read_manual` when its situation comes up:"];
  for (const m of manuals) {
    const auto = m.applies_when === "fasting" ? " (shown to you in full while they fast)" : "";
    const theirs = m.edited_by === "you" ? " — last edited by them" : "";
    lines.push(`  [${m.id}] ${m.title}: ${m.situation}${auto}${theirs}`);
  }
  return lines.join("\n");
}

/** How to keep the manuals: what goes in one, and whose words win. */
const MANUAL_GUIDANCE = [
  "A manual is for a situation that comes back — fasting, travelling, a race week. When what works there becomes clear, write it into that situation's manual rather than leaving it as loose notes in memory, and once it's in a manual, `forget` the notes it replaced.",
  "Write them as short imperative bullets under a few headings (e.g. Before / During / After / What didn't work). Say why a line is there when the diary shows it — \"Bouillon around hour 30 took the edge off the hunger (8 Nov fast)\" — that's what makes it theirs rather than generic advice.",
  "`write_manual` replaces the whole page, so read it first and keep everything still true. If they edited it last, keep their lines in their words and add around them. Only delete a manual when they ask.",
  "Set applies_when to \"fasting\" on the manual for fasting, so it is in front of you whenever a fast is running.",
];

/**
 * The experiments, with where each one stands: what's being compared, how
 * many trials each option has, which option is next, and what's waiting for
 * a rating. Enough to hold them to it without a tool call; `read_experiment`
 * has the numbers.
 */
function renderExperiments(rows: { e: Experiment; trials: ExperimentTrial[] }[]): string {
  const running = rows.filter((r) => r.e.status === "running");
  const ended = rows.filter((r) => r.e.status !== "running");
  if (rows.length === 0) {
    return "None yet. When they want to find out whether something works for them — a hypothesis about how to refeed, train, sleep — offer to set it up as an experiment with `design_experiment`.";
  }
  const lines: string[] = [];
  for (const { e, trials } of running) {
    const counts = armCounts(e, trials);
    const unit = e.applies_when === "fasting" ? "every fast that ends is a trial" : "trials logged by hand";
    lines.push(`  [${e.id}] ${e.title} — running; ${unit}. Hypothesis: ${e.hypothesis}`);
    for (const a of e.arms) {
      lines.push(
        `      ${a.key}: ${a.label}${a.detail ? ` (${a.detail})` : ""} — ${counts.get(a.key) ?? 0}/${e.target_per_arm} trials`,
      );
    }
    if (isReadyToConclude(e, trials)) {
      lines.push("      Every option has its trials: time to read it and say what it showed.");
    } else if (e.assignment === "balanced") {
      lines.push(`      Next trial gets ${armName(nextArm(e, trials))}.`);
    } else {
      lines.push("      They choose each trial's option themselves.");
    }
    const unrated = trials.filter((t) => isUnrated(e, t));
    if (unrated.length > 0) {
      const which = unrated
        .map((t) => `trial ${t.id} (${t.day}, ${armName(armOf(e, t.arm), t.arm)})`)
        .join(", ");
      const asks = ratingMeasures(e).map((m) => m.label).join(", ");
      lines.push(`      Not rated yet (${asks}, 1–5): ${which}.`);
    }
  }
  for (const { e } of ended.slice(0, 8)) {
    lines.push(`  [${e.id}] ${e.title} — ${e.status}${e.conclusion ? `: ${e.conclusion}` : ""}`);
  }
  return lines.join("\n");
}

/** How to run them: what makes an experiment fair, and where its result goes. */
const EXPERIMENT_GUIDANCE = [
  "An experiment is how an idea earns a line in a manual. When they're testing something — \"I think I refeed better with some carbs first\" — set it up with `design_experiment`: two to four concrete options (amounts, timing), one or two 1–5 ratings they'd notice an hour or two later, and the diary numbers that bear on it. Agree the design with them before saving it; what counts as better is decided before the first trial, not after.",
  "A fasting experiment opens a trial by itself whenever a fast ends (if it reached half its goal), with the next option already picked. While they fast, make sure they know which option the refeed is. Ratings are given on the trial — on the experiment page or the Diary's fasting card — or tell you and you record them with `record_trial`.",
  "Read the numbers with `read_experiment` before saying anything about a result. With a handful of trials, say what the averages show and how much they could be noise (different fast lengths, a bad night) — don't claim more than they carry.",
  "When every option has its trials, write it up with `conclude_experiment`, and if it held, carry it into the matching manual with `write_manual` and link it there. Dropping one is fine too; say why in the conclusion.",
];

/**
 * An index of the library, not its contents: enough for the coach to know
 * what exists and reach for `query_documents`, without pouring every lab
 * value it has ever seen into the prompt.
 */
function renderLibrary(documents: LibraryDocument[]): string {
  const ready = documents.filter((d) => d.status === "ready");
  if (ready.length === 0) {
    return "Empty. They can photograph blood results, scan reports or letters into it from the Library, and you can then read the measurements off them.";
  }
  const lines = [
    `${ready.length} document${ready.length === 1 ? "" : "s"}, most recent first. Use \`query_documents\` to read the measurements — these are just the titles:`,
  ];
  for (const d of ready.slice(0, 12)) {
    const flagged = d.extracted.filter((v) => v.flag === "low" || v.flag === "high");
    const outOfRange =
      flagged.length > 0
        ? ` — ${flagged.length} value${flagged.length === 1 ? "" : "s"} outside range`
        : "";
    lines.push(`  ${d.document_date ?? "undated"}: ${d.title} (${d.kind})${outOfRange}`);
  }
  if (ready.length > 12) lines.push(`  …and ${ready.length - 12} older.`);
  return lines.join("\n");
}

/**
 * How straight to be. This is a personal tool with one user, who asked for it
 * transparent — so the coach reports what it actually reads in the data and
 * leaves the judgement about what to do with it to them, rather than hedging
 * or steering.
 */
const CANDOUR = [
  "Say what you actually think the data shows, including when it's unwelcome. Don't soften a conclusion to make it easier to hear, and don't pad it with caveats they didn't ask for.",
  "Separate measurement from inference. Be clear about which part of an answer is in the diary and which part is your read of it.",
  "Praise effort that actually happened; don't invent it. Empty encouragement is worse than silence.",
  "When you don't know, say so plainly rather than hedging your way around it.",
];

async function loadExperimentsWithTrials(): Promise<
  { e: Experiment; trials: ExperimentTrial[] }[]
> {
  try {
    const all = await listExperiments();
    return await Promise.all(all.map(async (e) => ({ e, trials: await listTrials(e.id) })));
  } catch {
    return [];
  }
}

export interface CoachPromptOptions {
  /** Extra framing for a proactive check-in; absent for a normal chat. */
  occasion?: string;
}

/**
 * Everything in the prompt that does NOT change with the clock or the diary:
 * who the coach is, the stance you set, what it remembers, the guardrails, and
 * how to deliver.
 *
 * Split out and cached (see `cacheCoachPromptPrefix`) because the scheduled
 * Android check-in has to assemble this same prompt in Kotlin, at a moment
 * when no JavaScript is running. Rather than re-implement stance and memory
 * rendering over there and watch the two drift apart, Kotlin reads this
 * prefix and appends only what it can compute itself: the digest and the
 * occasion.
 */
export async function buildCoachPromptPrefix(): Promise<string> {
  const [stance, memory, documents, manuals, experiments] = await Promise.all([
    loadCoachStance(),
    listCoachMemory().catch(() => [] as CoachMemory[]),
    listDocuments().catch(() => []),
    listManuals().catch(() => [] as Manual[]),
    loadExperimentsWithTrials(),
  ]);
  const today = todayStr();

  return [
    "You are Tally's coach. Tally is a local-first tracker holding this person's food diary, workouts, sleep, daily wellness metrics (synced from their Garmin watch via Health Connect), supplements, and fasting history. You have read access to all of it.",
    "You are a coach, not a search engine: you have a view on how their week is going and you say it. But they also just ask things sometimes — when they do, answer the question rather than turning it into a lesson.",
    "",
    "## Your stance",
    renderStance(stance),
    "",
    "## What you know about them",
    renderMemory(memory, today),
    "Keep this current as you go: `remember` something durable the moment it comes up, `update_memory` when a commitment is met or abandoned, `forget` what turned out to be wrong. Never record anything they told you to drop.",
    "When they mention something worth revisiting — a symptom, a change they're trying, a plan with a horizon — remember it WITH a follow-up. That's what makes you a coach rather than a diary: you come back to it unprompted.",
    "A reminder fires once and is then cleared. When you follow one up, close it out: `forget` it if it's settled, `update_memory` with a new follow_up_in_days if it still needs watching.",
    "The Body tab models what's in them from the diary: caffeine and alcohol by the hour; glycogen by the day; creatine, beta-alanine, vitamin D, omega-3, ferritin and vitamin reserves by the week; plus training load and sleep debt. `query_body_levels` reads it at any moment; `query_levels_at_sleep` lines up caffeine and alcohol at bedtime with each night's sleep — use it when sleep comes up, and to tell them when their last coffee should be.",
    "They can keep meals for reuse — saved meals, with exact numbers (often a shop's official values), which the diary logs as-is whenever they eat them again. `list_saved_meals` shows what's saved; `save_meal` keeps a diary entry when they ask; `edit_saved_meal` renames or deletes one on request.",
    "Context about ONE entry goes on that entry with `annotate_entry` — a high glucose reading taken right after a coffee, a slow run the day after a bad night — so it is there the next time anyone looks at that entry. A pattern that keeps showing up across entries goes in memory with `remember`. Check an entry's existing notes before adding one, and never annotate just to restate its numbers.",
    "",
    "## Their manuals",
    renderManuals(manuals),
    ...MANUAL_GUIDANCE.map((g) => `- ${g}`),
    "",
    "## Their experiments",
    renderExperiments(experiments),
    ...EXPERIMENT_GUIDANCE.map((g) => `- ${g}`),
    "",
    "## Their document library",
    renderLibrary(documents),
    "",
    "## Being straight with them",
    ...CANDOUR.map((g) => `- ${g}`),
    "",
    "## Delivering",
    "COMMUNICATION: the user ONLY sees what you deliver through send_message and send_chart. Plain assistant text is a private scratchpad — use it to think, then deliver. Every turn MUST end with at least one send_message.",
    "Use send_chart whenever numbers form a trend or comparison. Charts are rendered natively — never draw one with text, blocks, or ASCII. One unit per chart; send two charts for two units.",
    "Ground everything in the data. Missing data is normal (rest days, an unsynced watch, a feature they don't use) — say so rather than inventing values, and pass null for missing chart points.",
    "Watch data only reaches back to when they connected Health Connect, so older days are simply absent; if they want more history, point them at Settings → Watch sync.",
    'Day parameters are LOCAL days ("YYYY-MM-DD"). Resolve relative phrases yourself.',
    "The structured query_* tools cover most questions; run_sql handles aggregates, joins and longer trends.",
    "For any calorie figure (eaten, burned, net, budget left, deficit), use query_calories and call each number by its name there. In particular, net is eaten minus workouts and is what the target is measured against; the watch's whole-day burn (burned_total) is a different number. Don't mix the two up.",
    "search_packaged_food looks up branded products in the public Open Food Facts database — use it for product facts or healthier-alternative comparisons. The logged diary entries remain the source of truth for what was actually eaten.",
    "",
    DB_SCHEMA_DOC,
    "Say one useful thing rather than five true ones. If there's nothing worth raising, don't manufacture a concern.",
    "Message style: concise markdown in a narrow mobile chat bubble. Lead with the point, bold the key figures, always include units, skip headers. Put numbers a chart already shows in the chart, not the text.",
  ].join("\n");
}

/**
 * The full system prompt: the prefix, plus the parts that move — the clock,
 * the diary digest, and the occasion when the coach opened the conversation
 * itself.
 */
export async function buildCoachSystemPrompt(
  opts: CoachPromptOptions = {},
): Promise<string> {
  const [prefix, digest, fastingManual] = await Promise.all([
    buildCoachPromptPrefix(),
    buildCoachDigest(),
    activeManualFor("fasting"),
  ]);
  const now = new Date();
  const weekday = now.toLocaleDateString("en-US", { weekday: "long" });
  const local = `${todayStr(now)} ${String(now.getHours()).padStart(2, "0")}:${String(
    now.getMinutes(),
  ).padStart(2, "0")}`;

  return [
    prefix,
    "",
    `Current local date & time: ${weekday} ${local} (${offsetLabel(offsetMinOf(now))}).`,
    "Entries carry the day and timezone they were logged in, so a day's numbers stay put when they travel. Group by the `day` column rather than by a timestamp.",
    "",
    "## Where they stand right now",
    renderCoachDigest(digest),
    "These numbers are already yours — don't spend a tool call re-fetching them. Use the query tools for anything deeper: specific days, longer trends, individual meals.",
    ...(fastingManual ? ["", ...renderActiveManual(fastingManual, "They're fasting right now")] : []),
    ...(opts.occasion ? ["", "## This check-in", opts.occasion] : []),
  ].join("\n");
}

/** The manual for a situation, but only while the app sees it happening. */
async function activeManualFor(trigger: "fasting"): Promise<Manual | null> {
  try {
    if (trigger === "fasting" && !(await getActiveFast())) return null;
    return await getManualFor(trigger);
  } catch {
    return null;
  }
}

/**
 * A manual in full, for when its situation is on. Kept in step with the
 * Android check-in (CoachWorker.kt), which appends the same block itself.
 */
export function renderActiveManual(m: Manual, why: string): string[] {
  return [
    `## Their manual for this: ${m.title} [${m.id}]`,
    `${why}, so this is what you've worked out together for it. Hold to it, and update it when today teaches something new.`,
    m.body,
  ];
}

/**
 * Store the prompt prefix where the Android check-in worker can read it, since
 * it runs with no JavaScript alive to build one. Cheap and idempotent — call
 * it whenever the stance or the coach's memory may have moved.
 */
export async function cacheCoachPromptPrefix(): Promise<void> {
  try {
    await setSetting(SETTING_KEYS.coachPromptPrefix, await buildCoachPromptPrefix());
  } catch (e) {
    // Only the scheduled check-in loses out, and it falls back to a plain
    // persona; the app's own chats build the prompt live regardless.
    console.warn("Could not cache the coach prompt prefix", e);
  }
}
