/**
 * Performance stats: the numbers a watch app shows about fitness rather than
 * about one day — FTP, VO₂ max, HRV, lactate threshold, race predictions.
 * Logged from a screenshot (Garmin Connect's "Performance Stats" page, say)
 * through the diary agent, or from a note.
 *
 * The catalogue below is what gets a fixed key, label and unit, so the same
 * stat read off two screenshots a month apart lands on the same line of a
 * trend. Anything else the screen shows is kept too, under a slug of its own
 * label — a stat Garmin adds next year shouldn't be thrown away.
 *
 * Paces and durations are stored as seconds, so they can be averaged and
 * charted like any other number; `format` says how to show them.
 */
import type { PerformanceStat } from "./types";

/** Shown in place of a screenshot when the stats came from a note. */
export const PERFORMANCE_GLYPH = "📈";

export type StatFormat = "number" | "pace" | "duration";

export interface StatDef {
  label: string;
  unit: string | null;
  format: StatFormat;
  /** Decimals shown for plain numbers. */
  dp: number;
  /** A value outside this is a misread, not a fitness level. */
  min: number;
  max: number;
  /** For the agent: what this is and where it shows up. */
  hint: string;
}

export const STAT_DEFS = {
  vo2max: { label: "VO₂ max", unit: "ml/kg/min", format: "number", dp: 0, min: 10, max: 95, hint: "VO2 max (running or cycling)" },
  vo2max_cycling: { label: "VO₂ max (cycling)", unit: "ml/kg/min", format: "number", dp: 0, min: 10, max: 95, hint: "VO2 max when the screen shows a separate cycling value" },
  ftp: { label: "FTP", unit: "W", format: "number", dp: 0, min: 30, max: 600, hint: "Functional threshold power in watts" },
  ftp_wkg: { label: "FTP per kg", unit: "W/kg", format: "number", dp: 2, min: 0.5, max: 8, hint: "FTP in W/kg when shown" },
  hrv: { label: "HRV", unit: "ms", format: "number", dp: 0, min: 5, max: 250, hint: "Overnight HRV average (last night)" },
  hrv_7d: { label: "HRV 7-day avg", unit: "ms", format: "number", dp: 0, min: 5, max: 250, hint: "HRV 7-day average" },
  resting_hr: { label: "Resting HR", unit: "bpm", format: "number", dp: 0, min: 25, max: 120, hint: "Resting heart rate" },
  max_hr: { label: "Max HR", unit: "bpm", format: "number", dp: 0, min: 100, max: 230, hint: "Maximum heart rate" },
  lactate_threshold_hr: { label: "Lactate threshold HR", unit: "bpm", format: "number", dp: 0, min: 80, max: 220, hint: "Lactate threshold heart rate" },
  lactate_threshold_pace: { label: "Lactate threshold pace", unit: "s/km", format: "pace", dp: 0, min: 120, max: 900, hint: "Lactate threshold pace, as SECONDS PER KM (4:30 /km → 270; convert /mi by ÷1.609)" },
  lactate_threshold_power: { label: "Lactate threshold power", unit: "W", format: "number", dp: 0, min: 30, max: 700, hint: "Running lactate threshold power" },
  training_readiness: { label: "Training readiness", unit: null, format: "number", dp: 0, min: 0, max: 100, hint: "Training readiness score 0-100" },
  endurance_score: { label: "Endurance score", unit: null, format: "number", dp: 0, min: 0, max: 15000, hint: "Garmin endurance score" },
  hill_score: { label: "Hill score", unit: null, format: "number", dp: 0, min: 0, max: 100, hint: "Garmin hill score" },
  acute_load: { label: "Acute load", unit: null, format: "number", dp: 0, min: 0, max: 5000, hint: "Acute training load" },
  recovery_time: { label: "Recovery time", unit: "h", format: "number", dp: 0, min: 0, max: 96, hint: "Recovery time in hours" },
  body_battery: { label: "Body Battery", unit: null, format: "number", dp: 0, min: 0, max: 100, hint: "Body Battery 0-100" },
  stress: { label: "Stress", unit: null, format: "number", dp: 0, min: 0, max: 100, hint: "Average stress level 0-100" },
  fitness_age: { label: "Fitness age", unit: "years", format: "number", dp: 0, min: 10, max: 100, hint: "Fitness age in years" },
  race_5k: { label: "5K prediction", unit: "s", format: "duration", dp: 0, min: 600, max: 4800, hint: "Race predictor 5K, as SECONDS (21:30 → 1290)" },
  race_10k: { label: "10K prediction", unit: "s", format: "duration", dp: 0, min: 1200, max: 9600, hint: "Race predictor 10K, as SECONDS" },
  race_half: { label: "Half marathon prediction", unit: "s", format: "duration", dp: 0, min: 2700, max: 21600, hint: "Race predictor half marathon, as SECONDS" },
  race_marathon: { label: "Marathon prediction", unit: "s", format: "duration", dp: 0, min: 5400, max: 43200, hint: "Race predictor marathon, as SECONDS" },
} satisfies Record<string, StatDef>;

export type StatKey = keyof typeof STAT_DEFS;

export function isStatKey(v: unknown): v is StatKey {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(STAT_DEFS, v);
}

export function statKeys(): StatKey[] {
  return Object.keys(STAT_DEFS).filter(isStatKey);
}

/** The catalogue entry for a stored metric, or null for one of their own. */
export function statDef(metric: string): StatDef | null {
  return isStatKey(metric) ? STAT_DEFS[metric] : null;
}

/** A metric key for a stat that isn't in the catalogue: its label, slugged. */
export function customMetricKey(label: string): string {
  const slug = label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `custom_${slug || "stat"}`;
}

function clock(totalSeconds: number): string {
  const s = Math.round(totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(sec).padStart(2, "0")}`;
}

/** The value as it would read on the watch, without its unit. */
export function formatStatValue(stat: Pick<PerformanceStat, "metric" | "value">): string {
  const def = statDef(stat.metric);
  if (def?.format === "pace" || def?.format === "duration") return clock(stat.value);
  const dp = def?.dp ?? (Number.isInteger(stat.value) ? 0 : 1);
  return stat.value.toFixed(dp);
}

/** The unit as it should be shown next to the value; null when it has none. */
export function displayUnit(stat: Pick<PerformanceStat, "metric" | "unit">): string | null {
  const def = statDef(stat.metric);
  if (def?.format === "pace") return "/km";
  if (def?.format === "duration") return null;
  return stat.unit;
}

export function formatStat(stat: Pick<PerformanceStat, "metric" | "value" | "unit">): string {
  const unit = displayUnit(stat);
  return `${formatStatValue(stat)}${unit ? ` ${unit}` : ""}`;
}

/**
 * What was typed into the editor, back as the stored number. Paces and times
 * are typed as they read ("4:35", "1:42:10"); a bare number is taken as
 * already in the stored unit.
 */
export function parseStatInput(metric: string, raw: string): number {
  const t = raw.trim().replace(",", ".");
  const def = statDef(metric);
  let n: number;
  if (/^\d+(:\d{1,2}){1,2}$/.test(t)) {
    n = t.split(":").map(Number).reduce((a, b) => a * 60 + b, 0);
  } else {
    n = parseFloat(t);
  }
  if (!isFinite(n)) throw new Error("Give it a number.");
  if (def && (n < def.min || n > def.max)) {
    const lo = formatStat({ metric, value: def.min, unit: def.unit });
    const hi = formatStat({ metric, value: def.max, unit: def.unit });
    throw new Error(`${def.label} reads between ${lo} and ${hi}.`);
  }
  return n;
}

/** The headline stats, in the order a diary row lists them. */
export function orderStats(stats: PerformanceStat[]): PerformanceStat[] {
  const order = statKeys() as string[];
  const rank = (m: string) => {
    const i = order.indexOf(m);
    return i < 0 ? order.length : i;
  };
  return [...stats].sort((a, b) => rank(a.metric) - rank(b.metric));
}

/** One line for the timeline: the first few stats, short. */
export function statsSummary(stats: PerformanceStat[], max = 3): string {
  const shown = orderStats(stats).slice(0, max);
  const rest = stats.length - shown.length;
  const parts = shown.map((s) => `${s.label} ${formatStat(s)}`);
  if (rest > 0) parts.push(`+${rest} more`);
  return parts.join(" · ");
}
