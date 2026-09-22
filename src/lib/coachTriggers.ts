/**
 * When the coach gets to speak on its own.
 *
 * The failure mode for a proactive coach is obvious and fatal: fire a message
 * per rule, get muted, feature dead. So triggers don't send anything. They
 * produce *candidates*, and one evaluation pass picks at most one to speak —
 * every other firing condition is handed to that message as material rather
 * than becoming a message of its own.
 *
 * Evaluation is deterministic and local: plain comparisons over the digest, no
 * model involved. The model is only asked to phrase the winner. That keeps the
 * cost of "nothing to say" at zero, stops the coach inventing reasons to talk,
 * and — because it's all plain comparisons over a digest of plain sums — lets
 * the same decision be made in Kotlin when the scheduled check-in fires with
 * no JavaScript alive (see the plugin under src-tauri/plugins/coach).
 *
 * Two kinds of trigger:
 *
 * - **occasion** — a time arriving (the daily close-out). It has a reason to
 *   speak even when nothing is wrong.
 * - **condition** — something being true that shouldn't be. Carries a cooldown
 *   so it raises a thing once, not every day until fixed.
 */
import { invoke } from "@tauri-apps/api/core";
import { addCoachRun, listCoachRunsSince, getSetting, setSetting, todayStr } from "./db";
import { CoachTriggersSchema, parseJson } from "./schemas";
import { SETTING_KEYS } from "./types";
import type { CoachDigest } from "./coach";

export type TriggerKey =
  | "follow_up_due"
  | "daily_closeout"
  | "protein_short"
  | "target_drift"
  | "sleep_debt"
  | "streak_risk";

/** A memory whose reminder has come due. */
export interface DueFollowUp {
  id: number;
  text: string;
  /** The day it was set for; may be in the past if the app wasn't opened. */
  followUpOn: string;
}

export interface TriggerConfig {
  enabled: boolean;
  /** Earliest local hour it may fire; undefined when time-independent. */
  hour?: number;
  /** The number the condition compares against; undefined when it has none. */
  threshold?: number;
}

export type CoachTriggers = Record<TriggerKey, TriggerConfig>;

export interface TriggerContext {
  digest: CoachDigest;
  /** Local hour, 0-23. */
  hour: number;
  config: TriggerConfig;
  /**
   * Reminders that have come due. Not part of the digest — that's a read of
   * the diary, and these are the coach's own notes to itself.
   */
  dueFollowUps: DueFollowUp[];
}

export interface TriggerDef {
  key: TriggerKey;
  kind: "occasion" | "condition";
  /** Shown in Settings. */
  title: string;
  help: string;
  defaults: TriggerConfig;
  hourLabel?: string;
  thresholdLabel?: string;
  /**
   * Higher speaks first. Conditions outrank the close-out: if something is
   * actually wrong, that's the more useful thing to open with.
   */
  salience: number;
  /** Days before this may fire again. Occasions repeat daily. */
  cooldownDays: number;
  /**
   * The fact, in one line, when it fires — null when it doesn't. This text
   * goes to the model verbatim, so it states what is true and never what to
   * say about it.
   */
  evaluate: (ctx: TriggerContext) => string | null;
}

/** Enough logged days for an average to mean anything. */
const MIN_DAYS_FOR_TREND = 3;

export const TRIGGERS: TriggerDef[] = [
  {
    key: "follow_up_due",
    kind: "occasion",
    title: "Following up",
    help: "When something the coach noted down comes due — a symptom you mentioned, a change you were trying. It sets these itself as you talk.",
    defaults: { enabled: true },
    // Above every condition: coming back to something you raised yourself is
    // the most coach-like thing it does, and the least replaceable.
    salience: 50,
    cooldownDays: 1,
    evaluate: ({ dueFollowUps }) => {
      if (dueFollowUps.length === 0) return null;
      const items = dueFollowUps.map((f) => `"${f.text}" (noted for ${f.followUpOn})`);
      return (
        `You set yourself a reminder to come back to ${items.length === 1 ? "this" : "these"}: ` +
        `${items.join("; ")}. Ask how it's going, specifically — not in general terms.`
      );
    },
  },
  {
    key: "target_drift",
    kind: "condition",
    title: "Target looks wrong",
    help: "When a full week sits consistently above or below your calorie target, the target is probably the thing that's off — not you.",
    defaults: { enabled: true, threshold: 300 },
    thresholdLabel: "Off by more than (kcal/day)",
    salience: 40,
    cooldownDays: 7,
    evaluate: ({ digest, config }) => {
      const { avgNet, daysLogged } = digest.week;
      const target = digest.today.target;
      const limit = config.threshold ?? 300;
      if (avgNet == null || target == null || daysLogged < 5) return null;
      const drift = avgNet - target;
      if (Math.abs(drift) <= limit) return null;
      return (
        `Over the last ${daysLogged} logged days they averaged ${Math.round(avgNet)} kcal net ` +
        `against a ${target} kcal target — ${Math.abs(Math.round(drift))} kcal/day ` +
        `${drift > 0 ? "above" : "below"} it, consistently. Consider whether the target itself is set right.`
      );
    },
  },
  {
    key: "protein_short",
    kind: "condition",
    title: "Protein running low",
    help: "When the week's average protein sits under your floor.",
    defaults: { enabled: true, threshold: 100 },
    thresholdLabel: "Daily protein floor (g)",
    salience: 30,
    cooldownDays: 5,
    evaluate: ({ digest, config }) => {
      const { avgProteinG, daysLogged } = digest.week;
      const floor = config.threshold ?? 100;
      if (avgProteinG == null || daysLogged < MIN_DAYS_FOR_TREND) return null;
      if (avgProteinG >= floor) return null;
      return (
        `Protein has averaged ${Math.round(avgProteinG)} g/day over ${daysLogged} logged days, ` +
        `under their ${floor} g floor.`
      );
    },
  },
  {
    key: "sleep_debt",
    kind: "condition",
    title: "Sleep debt building",
    help: "When the week's average night is shorter than you want it to be.",
    defaults: { enabled: true, threshold: 7 },
    thresholdLabel: "Nightly hours wanted",
    salience: 35,
    cooldownDays: 5,
    evaluate: ({ digest, config }) => {
      const { avgSleepH, sleepNights } = digest.week;
      const want = config.threshold ?? 7;
      if (avgSleepH == null || sleepNights < MIN_DAYS_FOR_TREND) return null;
      if (avgSleepH >= want) return null;
      return (
        `Sleep has averaged ${avgSleepH} h across ${sleepNights} nights, under the ${want} h they want.`
      );
    },
  },
  {
    key: "streak_risk",
    kind: "condition",
    title: "Streak about to break",
    help: "Late in the evening with nothing logged and a streak running. Off by default — it's the one most likely to feel like nagging.",
    defaults: { enabled: false, hour: 20 },
    hourLabel: "Not before",
    salience: 20,
    cooldownDays: 1,
    evaluate: ({ digest, hour, config }) => {
      if (hour < (config.hour ?? 20)) return null;
      if (digest.streak.todayLogged || digest.streak.current <= 0) return null;
      return `Nothing logged today and a ${digest.streak.current}-day logging streak is about to break.`;
    },
  },
  {
    key: "daily_closeout",
    kind: "occasion",
    title: "Daily close-out",
    help: "An end-of-day read on how the day went, and one concrete thing for tomorrow.",
    defaults: { enabled: true, hour: 21 },
    hourLabel: "Not before",
    salience: 10,
    cooldownDays: 1,
    evaluate: ({ digest, hour, config }) => {
      if (hour < (config.hour ?? 21)) return null;
      // Nothing logged means nothing to close out; streak_risk covers that case.
      if (digest.today.itemsLogged === 0) return null;
      return `End of ${digest.day}. Close the day out: how it went against the target, and one concrete thing for tomorrow.`;
    },
  },
];

export const TRIGGERS_BY_KEY = new Map(TRIGGERS.map((t) => [t.key, t]));

export function defaultTriggers(): CoachTriggers {
  const out = {} as CoachTriggers;
  for (const t of TRIGGERS) out[t.key] = { ...t.defaults };
  return out;
}

export async function loadCoachTriggers(): Promise<CoachTriggers> {
  const out = defaultTriggers();
  const raw = await getSetting(SETTING_KEYS.coachTriggers).catch(() => null);
  if (!raw) return out;
  try {
    const stored = CoachTriggersSchema.parse(parseJson(raw));
    for (const t of TRIGGERS) {
      const s = stored[t.key];
      if (!s) continue;
      // Each field falls back independently, so a config written before a
      // trigger gained a threshold still picks the new default up.
      out[t.key] = {
        enabled: s.enabled ?? t.defaults.enabled,
        ...(t.defaults.hour !== undefined
          ? { hour: s.hour ?? t.defaults.hour }
          : {}),
        ...(t.defaults.threshold !== undefined
          ? { threshold: s.threshold ?? t.defaults.threshold }
          : {}),
      };
    }
  } catch {
    /* unreadable config — the defaults above stand */
  }
  return out;
}

export async function saveCoachTriggers(triggers: CoachTriggers): Promise<void> {
  await setSetting(SETTING_KEYS.coachTriggers, JSON.stringify(triggers));
}

// ---------------------------------------------------------------------------
// The scheduled wake-up
// ---------------------------------------------------------------------------

export const DEFAULT_CHECKIN_HOUR = 21;

export async function loadCheckinHour(): Promise<number> {
  const raw = await getSetting(SETTING_KEYS.coachCheckinHour).catch(() => null);
  const n = raw != null ? parseInt(raw, 10) : NaN;
  return isFinite(n) && n >= 0 && n <= 23 ? n : DEFAULT_CHECKIN_HOUR;
}

export async function saveCheckinHour(hour: number): Promise<void> {
  const clamped = Math.min(23, Math.max(0, Math.round(hour)));
  await setSetting(SETTING_KEYS.coachCheckinHour, String(clamped));
}

/**
 * Point the Android alarm at the configured hour, or cancel it when every
 * trigger is off.
 *
 * One wake-up a day, matching the one-message budget: there's no point waking
 * twice to decide something that can only be said once. Per-trigger hours stay
 * meaningful as "not before" guards within that evaluation.
 *
 * A no-op everywhere but Android, where the app evaluates check-ins while it's
 * running anyway.
 */
export async function syncCoachSchedule(): Promise<void> {
  try {
    const triggers = await loadCoachTriggers();
    const anyEnabled = TRIGGERS.some((t) => triggers[t.key]?.enabled);
    if (!anyEnabled) {
      await invoke("plugin:coach|cancel_checkin");
      return;
    }
    await invoke("plugin:coach|schedule_checkin", {
      hour: await loadCheckinHour(),
      minute: 0,
    });
  } catch (e) {
    // Desktop, dev in a browser, or an OEM that refuses alarms. The in-app
    // evaluation on open still runs; only the unattended one is lost.
    console.warn("Could not schedule the coach check-in", e);
  }
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/** At most this many coach-started check-ins in one day, whatever fires. */
export const DAILY_BUDGET = 1;

export interface TriggerCandidate {
  key: TriggerKey;
  kind: TriggerDef["kind"];
  salience: number;
  fact: string;
}

export interface Evaluation {
  /** The candidate that gets to speak, or null for "say nothing". */
  winner: TriggerCandidate | null;
  /** Everything else that's true right now — material for the message. */
  alsoTrue: TriggerCandidate[];
  /** Why nothing is being sent, when winner is null. For logs and tests. */
  reason: "budget" | "cooldown" | "nothing" | "ok";
}

function shiftDay(day: string, delta: number): string {
  const [y = 0, m = 1, d = 1] = day.split("-").map(Number);
  return todayStr(new Date(y, m - 1, d + delta));
}

/**
 * Decide whether the coach speaks, and about what.
 *
 * Pure apart from its inputs, so the whole decision is testable without a
 * model, a database, or a clock.
 */
export function evaluateTriggers(args: {
  digest: CoachDigest;
  hour: number;
  triggers: CoachTriggers;
  /** Day → trigger keys already fired, for cooldowns and the daily budget. */
  history: { day: string; key: string }[];
  today: string;
  dueFollowUps?: DueFollowUp[];
}): Evaluation {
  const { digest, hour, triggers, history, today } = args;
  const dueFollowUps = args.dueFollowUps ?? [];

  const firedToday = history.filter((h) => h.day === today).length;
  const candidates: TriggerCandidate[] = [];
  for (const def of TRIGGERS) {
    const config = triggers[def.key];
    if (!config?.enabled) continue;
    const fact = def.evaluate({ digest, hour, config, dueFollowUps });
    if (fact) candidates.push({ key: def.key, kind: def.kind, salience: def.salience, fact });
  }
  if (candidates.length === 0) return { winner: null, alsoTrue: [], reason: "nothing" };

  candidates.sort((a, b) => b.salience - a.salience);

  // Budget is checked after collecting, so "nothing to say" and "already said
  // today's piece" stay distinguishable.
  if (firedToday >= DAILY_BUDGET) {
    return { winner: null, alsoTrue: candidates, reason: "budget" };
  }

  const eligible = candidates.filter((c) => {
    const def = TRIGGERS_BY_KEY.get(c.key);
    if (!def) return false;
    const since = shiftDay(today, -(def.cooldownDays - 1));
    return !history.some((h) => h.key === c.key && h.day >= since);
  });
  if (eligible.length === 0) {
    return { winner: null, alsoTrue: candidates, reason: "cooldown" };
  }

  const winner = eligible[0] as TriggerCandidate;
  return {
    winner,
    alsoTrue: candidates.filter((c) => c.key !== winner.key),
    reason: "ok",
  };
}

/** The occasion text handed to the coach prompt for a winning candidate. */
export function occasionFor(e: Evaluation): string {
  if (!e.winner) return "";
  const lines = [
    "You are opening this conversation yourself — they haven't asked you anything. Lead with the point below, in one message.",
    `Reason you're speaking: ${e.winner.fact}`,
  ];
  if (e.alsoTrue.length > 0) {
    lines.push(
      "Also true right now, if and only if it's worth weaving in — do not list these:",
      ...e.alsoTrue.map((c) => `- ${c.fact}`),
    );
  }
  lines.push(
    "Say one useful thing and stop. No greeting, no preamble about checking their data.",
  );
  return lines.join("\n");
}

/** Read the history the evaluator needs (long enough for every cooldown). */
export async function loadTriggerHistory(
  today: string,
): Promise<{ day: string; key: string }[]> {
  const longest = Math.max(...TRIGGERS.map((t) => t.cooldownDays));
  const runs = await listCoachRunsSince(shiftDay(today, -longest)).catch(() => []);
  return runs.map((r) => ({ day: r.day, key: r.trigger_key }));
}

export async function recordTriggerRun(
  key: TriggerKey,
  today: string,
  chatId: number | null,
): Promise<void> {
  await addCoachRun(key, today, chatId).catch((e) => {
    // A lost record only risks a repeat check-in; never fail the message over it.
    console.warn("Could not record coach run", e);
  });
}
