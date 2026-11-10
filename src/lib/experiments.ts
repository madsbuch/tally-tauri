/**
 * Experiments: something that might work, under test.
 *
 * The coach's knowledge comes in shapes. Memory is single observations; a
 * manual is what works in one situation, settled. An experiment sits in
 * between — an idea about what works ("breaking a fast with carbs first, to
 * partly refill glycogen, makes re-entry easier") put to a fair test before
 * it goes in the manual.
 *
 * Fair, for one person, means three things, and each is something the app
 * does so willpower doesn't have to:
 *
 * - **The options are compared, not tried once.** An experiment has two to
 *   four arms, and each needs a few trials before it says anything.
 * - **The app picks the next option** (unless they asked to choose), taking
 *   the arm with the fewest trials — so it isn't chosen by mood on the day.
 * - **What counts as better is written down first.** Ratings they give an
 *   hour or two after (energy, gut feel) and numbers the diary already holds
 *   (the refeed's carbs, the night's sleep, the morning's weight).
 *
 * A fasting experiment opens a trial by itself whenever a fast ends, so the
 * fast is the unit and nothing has to be remembered. When enough trials are
 * in, the coach writes up what it showed — and, if it held, carries it into
 * the manual it was about.
 */
import {
  addExperiment,
  addTrial,
  deleteExperiment,
  deleteTrial,
  listFoodEntriesForRange,
  listHealthMetricsForRange,
  listRunningExperimentsFor,
  listSleepForRange,
  listTrialsForFast,
  listTrials,
  updateExperiment,
  updateTrial,
} from "./db";
import type { ExperimentDraft, ExperimentPatch, TrialPatch } from "./db";
import { cacheCoachPromptPrefix } from "./coach";
import { shiftDay } from "./daystamp";
import type { AutoMetric, ExperimentArm, ExperimentMeasure } from "./schemas";
import { AUTO_METRIC_INFO, REFEED_WINDOW_H } from "./experimentMetrics";

export { AUTO_METRIC_INFO, REFEED_WINDOW_H };
import type { Experiment, ExperimentTrial, Fast } from "./types";

export const EXPERIMENTS_CHANGED_EVENT = "tally:experiments-changed";

export const EXPERIMENT_GLYPH = "🧪";

/** An experiment's address: a page under the Coach tab. */
export function experimentPath(id: number): string {
  return `/assistant/experiments/${id}`;
}

/** The experiment id in a `:experimentId` param, or null when it isn't one. */
export function parseExperimentId(raw: string | undefined): number | null {
  if (!raw || !/^[1-9]\d*$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

export function notifyExperimentsChanged(): void {
  // Also called from lib code that runs where there's no window (tests).
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(EXPERIMENTS_CHANGED_EVENT));
}

export function onExperimentsChanged(handler: () => void): () => void {
  window.addEventListener(EXPERIMENTS_CHANGED_EVENT, handler);
  return () => window.removeEventListener(EXPERIMENTS_CHANGED_EVENT, handler);
}

/**
 * Every write goes through here: the coach's prompt carries each running
 * experiment's progress and next option (and the copy cached for the Android
 * check-in has to follow), and so does any screen showing them.
 */
async function changed(): Promise<void> {
  notifyExperimentsChanged();
  await cacheCoachPromptPrefix();
}

// ---------------------------------------------------------------------------
// What's measured
// ---------------------------------------------------------------------------

/** Hours after a refeed before the ratings are worth asking for. */
export const RATE_AFTER_H = 1.5;

/**
 * A fast shorter than this share of its goal was given up on rather than
 * finished, and its refeed isn't the thing being tested.
 */
export const MIN_FAST_SHARE = 0.5;

export function measureLabel(m: ExperimentMeasure): string {
  return m.kind === "auto" && m.key in AUTO_METRIC_INFO
    ? AUTO_METRIC_INFO[m.key as AutoMetric].label
    : m.label;
}

export function ratingMeasures(e: Experiment): ExperimentMeasure[] {
  return e.measures.filter((m) => m.kind === "rating");
}

/** Auto metrics that are also shown for a trial even when not chosen. */
const ALWAYS_SHOWN: AutoMetric[] = ["fast_h"];

function isAutoMetric(k: string): k is AutoMetric {
  return k in AUTO_METRIC_INFO;
}

/** The auto metrics an experiment reads: its chosen ones, plus fast length for a fasting one. */
export function autoMetricsOf(e: Experiment): AutoMetric[] {
  const chosen = e.measures.filter((m) => m.kind === "auto").map((m) => m.key).filter(isAutoMetric);
  const extra = e.applies_when === "fasting" ? ALWAYS_SHOWN : [];
  return [...new Set([...extra, ...chosen])];
}

export type TrialMetrics = Partial<Record<AutoMetric, number | null>>;

const H = 3_600_000;

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

/**
 * The numbers for each trial, read from what's logged. Computed rather than
 * stored: a meal logged late, or a night that syncs the next day, still
 * lands in the trial it belongs to.
 */
export async function loadTrialMetrics(
  trials: ExperimentTrial[],
  fasts: Map<number, Fast>,
): Promise<Map<number, TrialMetrics>> {
  const out = new Map<number, TrialMetrics>();
  if (trials.length === 0) return out;
  const days = trials.map((t) => t.day).sort();
  const first = days[0] as string;
  const last = shiftDay(days[days.length - 1] as string, 1);
  const [food, sleep, health] = await Promise.all([
    listFoodEntriesForRange(first, last).catch(() => []),
    listSleepForRange(first, last).catch(() => []),
    listHealthMetricsForRange(first, last).catch(() => []),
  ]);
  const healthByDay = new Map(health.map((h) => [h.day, h]));
  for (const t of trials) {
    const start = new Date(t.started_at).getTime();
    const meals = food.filter((f) => {
      const at = new Date(f.eaten_at).getTime();
      return at >= start - 60_000 && at <= start + REFEED_WINDOW_H * H;
    });
    const next = shiftDay(t.day, 1);
    const nights = sleep.filter((s) => s.day === next);
    const today = healthByDay.get(t.day);
    const tomorrow = healthByDay.get(next);
    const fast = t.fast_id != null ? fasts.get(t.fast_id) : undefined;
    const nutrient = (k: "calories" | "carbs_g" | "protein_g") =>
      meals.length ? sum(meals.map((m) => m.nutrients[k] ?? 0)) : null;
    out.set(t.id, {
      fast_h:
        fast?.ended_at != null
          ? (new Date(fast.ended_at).getTime() - new Date(fast.started_at).getTime()) / H
          : null,
      refeed_kcal: nutrient("calories"),
      refeed_carbs_g: nutrient("carbs_g"),
      refeed_protein_g: nutrient("protein_g"),
      sleep_h: nights.length ? sum(nights.map((s) => s.duration_min)) / 60 : null,
      hrv_ms: tomorrow?.hrv_ms ?? null,
      resting_hr: tomorrow?.resting_hr ?? null,
      weight_change_kg:
        today?.weight_kg != null && tomorrow?.weight_kg != null
          ? tomorrow.weight_kg - today.weight_kg
          : null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Progress and the next option
// ---------------------------------------------------------------------------

function counted(trials: ExperimentTrial[]): ExperimentTrial[] {
  return trials.filter((t) => !t.excluded);
}

/** Trials that count, per arm key. */
export function armCounts(e: Experiment, trials: ExperimentTrial[]): Map<string, number> {
  const out = new Map(e.arms.map((a) => [a.key, 0]));
  for (const t of counted(trials)) {
    if (out.has(t.arm)) out.set(t.arm, (out.get(t.arm) ?? 0) + 1);
  }
  return out;
}

/** Every arm has its trials: time to say what it showed. */
export function isReadyToConclude(e: Experiment, trials: ExperimentTrial[]): boolean {
  return [...armCounts(e, trials).values()].every((n) => n >= e.target_per_arm);
}

/**
 * The option the next trial gets: the one with fewest trials so far, and
 * between equals the one used longest ago (then the first listed) — which
 * makes two arms alternate.
 */
export function nextArm(e: Experiment, trials: ExperimentTrial[]): ExperimentArm {
  const counts = armCounts(e, trials);
  const lastUsed = new Map<string, number>();
  counted(trials).forEach((t, i) => lastUsed.set(t.arm, i));
  const ranked = [...e.arms].sort((a, b) => {
    const dc = (counts.get(a.key) ?? 0) - (counts.get(b.key) ?? 0);
    if (dc !== 0) return dc;
    return (lastUsed.get(a.key) ?? -1) - (lastUsed.get(b.key) ?? -1);
  });
  return ranked[0] ?? (e.arms[0] as ExperimentArm);
}

export function armOf(e: Experiment, key: string): ExperimentArm | undefined {
  return e.arms.find((a) => a.key === key);
}

/** "A · Carbs first". */
export function armName(arm: ExperimentArm | undefined, key = "?"): string {
  return arm ? `${arm.key} · ${arm.label}` : key;
}

/** A trial that counts and is missing a rating. */
export function isUnrated(e: Experiment, t: ExperimentTrial): boolean {
  return !t.excluded && ratingMeasures(e).some((m) => t.ratings?.[m.key] == null);
}

/** An unrated trial whose ratings are worth asking for by now. */
export function needsRating(e: Experiment, t: ExperimentTrial, now = Date.now()): boolean {
  return isUnrated(e, t) && now - new Date(t.started_at).getTime() >= RATE_AFTER_H * H;
}

export interface ArmSummary {
  arm: ExperimentArm;
  n: number;
  /** Measure key → mean over the trials that have it, and how many did. */
  means: Map<string, { mean: number; n: number }>;
}

/** Each arm's averages over the trials that count. */
export function summarize(
  e: Experiment,
  trials: ExperimentTrial[],
  metrics: Map<number, TrialMetrics>,
): ArmSummary[] {
  const keys = [
    ...ratingMeasures(e).map((m) => m.key),
    ...autoMetricsOf(e),
  ];
  return e.arms.map((arm) => {
    const mine = counted(trials).filter((t) => t.arm === arm.key);
    const means = new Map<string, { mean: number; n: number }>();
    for (const key of keys) {
      const vals: number[] = [];
      for (const t of mine) {
        const v = isAutoMetric(key) ? metrics.get(t.id)?.[key] : t.ratings?.[key];
        if (typeof v === "number" && isFinite(v)) vals.push(v);
      }
      if (vals.length) means.set(key, { mean: sum(vals) / vals.length, n: vals.length });
    }
    return { arm, n: mine.length, means };
  });
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function createExperiment(draft: ExperimentDraft): Promise<number> {
  const id = await addExperiment(draft);
  await changed();
  return id;
}

export async function saveExperiment(id: number, patch: ExperimentPatch): Promise<void> {
  await updateExperiment(id, patch);
  await changed();
}

export async function removeExperiment(id: number): Promise<void> {
  await deleteExperiment(id);
  await changed();
}

export async function startTrial(
  e: Experiment,
  arm: string,
  startedAt: string,
  fastId: number | null = null,
): Promise<number> {
  const id = await addTrial({ experiment_id: e.id, arm, fast_id: fastId, started_at: startedAt });
  await changed();
  return id;
}

export async function saveTrial(id: number, patch: TrialPatch): Promise<void> {
  await updateTrial(id, patch);
  await changed();
}

export async function removeTrial(id: number): Promise<void> {
  await deleteTrial(id);
  await changed();
}

/**
 * A fast just ended: it's a trial of every running fasting experiment, with
 * the option each one picked for it. Skipped when the fast was given up well
 * short of its goal, and never twice for the same fast.
 */
export async function openTrialsForFast(fast: Fast, endedAt: Date): Promise<void> {
  const hours = (endedAt.getTime() - new Date(fast.started_at).getTime()) / H;
  if (hours < fast.goal_hours * MIN_FAST_SHARE) return;
  const running = await listRunningExperimentsFor("fasting");
  if (running.length === 0) return;
  const existing = await listTrialsForFast(fast.id);
  let opened = false;
  for (const e of running) {
    if (existing.some((t) => t.experiment_id === e.id)) continue;
    const arm = nextArm(e, await listTrials(e.id));
    await addTrial({
      experiment_id: e.id,
      arm: arm.key,
      fast_id: fast.id,
      started_at: endedAt.toISOString(),
    });
    opened = true;
  }
  if (opened) await changed();
}
