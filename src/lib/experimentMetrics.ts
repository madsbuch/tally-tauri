/**
 * The numbers an experiment can read for a trial from what's already logged,
 * described once for the screens and the coach alike.
 *
 * A module of its own, importing nothing that runs, because the coach's tool
 * definitions read it while modules are still loading — and lib/experiments
 * sits in an import cycle with the coach.
 */
import type { AutoMetric } from "./schemas";

/** How long after a trial starts its refeed is counted. */
export const REFEED_WINDOW_H = 3;

export interface AutoMetricInfo {
  label: string;
  unit: string;
  better: "higher" | "lower";
  /** Decimal places to show. */
  dp: number;
  /** For the coach: exactly what the number is. */
  means: string;
}

export const AUTO_METRIC_INFO: Record<AutoMetric, AutoMetricInfo> = {
  fast_h: {
    label: "Fast length",
    unit: "h",
    better: "higher",
    dp: 1,
    means: "how long the fast before it lasted",
  },
  refeed_kcal: {
    label: "Refeed kcal",
    unit: "kcal",
    better: "lower",
    dp: 0,
    means: `kcal logged in the first ${REFEED_WINDOW_H} h`,
  },
  refeed_carbs_g: {
    label: "Refeed carbs",
    unit: "g",
    better: "higher",
    dp: 0,
    means: `carbs logged in the first ${REFEED_WINDOW_H} h; checks the option was followed`,
  },
  refeed_protein_g: {
    label: "Refeed protein",
    unit: "g",
    better: "higher",
    dp: 0,
    means: `protein logged in the first ${REFEED_WINDOW_H} h`,
  },
  sleep_h: {
    label: "Sleep after",
    unit: "h",
    better: "higher",
    dp: 1,
    means: "hours slept the night after",
  },
  hrv_ms: {
    label: "HRV next morning",
    unit: "ms",
    better: "higher",
    dp: 0,
    means: "HRV the morning after",
  },
  resting_hr: {
    label: "Resting HR next day",
    unit: "bpm",
    better: "lower",
    dp: 0,
    means: "resting heart rate the day after",
  },
  weight_change_kg: {
    label: "Weight, next morning",
    unit: "kg",
    better: "lower",
    dp: 1,
    means: "weight the morning after minus weight the day of the trial",
  },
};
