/**
 * What's in you right now, from what you've logged.
 *
 * Four things, on two clocks. Caffeine and alcohol come and go within a day:
 * they're absorbed over the best part of an hour and then cleared — caffeine
 * by halves (a half-life), alcohol at a steady rate however much is there,
 * which is why a fifth beer takes as long to clear as the first. Creatine and
 * vitamin D build up over weeks: a store that fills with every dose and slowly
 * drains when the doses stop, so a single day barely moves them. Vitamin D
 * also rides on the seasons — sun fills it in summer and winter drains it —
 * so its estimate starts from a seasonal baseline and a blood test, when
 * there is one, shifts that to the person.
 *
 * These are textbook models with average parameters, not measurements. People
 * clear caffeine anywhere from 3 to 7 hours (hence the setting), alcohol by
 * ±30%, and nobody's creatine store is known without a muscle biopsy. The
 * point is the shape — when the evening coffee is still in you at bedtime,
 * whether the creatine is topped up — not the decimal.
 *
 * Pure functions only; lib/body.ts feeds them from the diary.
 */

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

/** One intake: when (epoch ms) and how much (mg, g or µg — the substance's unit). */
export interface Dose {
  at: number;
  amount: number;
}

export interface Point {
  t: number;
  amount: number;
}

// ---------------------------------------------------------------------------
// Hours: caffeine and alcohol
// ---------------------------------------------------------------------------

export type Elimination =
  /** Clears a fixed fraction per hour: halves every `halfLifeH`. */
  | { kind: "half-life"; halfLifeH: number }
  /** Clears a fixed amount per hour, whatever is there (alcohol). */
  | { kind: "steady"; perHour: number };

export interface Kinetics {
  /** Half-life of the gut-to-blood step; ~15 min puts the peak 45-60 min in. */
  absorbHalfLifeH: number;
  elimination: Elimination;
}

export const STEP_MS = 5 * 60_000;

/** Caffeine: 5 h is the textbook adult average; the setting overrides it. */
export const DEFAULT_CAFFEINE_HALF_LIFE_H = 5;
export const CAFFEINE_HALF_LIVES = [3, 4, 5, 6, 7] as const;
/**
 * Roughly where caffeine stops measurably costing deep sleep. Not a cliff,
 * a line worth drawing so "when can I sleep" has an answer.
 */
export const CAFFEINE_SLEEP_MG = 50;

export function caffeineKinetics(halfLifeH = DEFAULT_CAFFEINE_HALF_LIFE_H): Kinetics {
  return { absorbHalfLifeH: 0.25, elimination: { kind: "half-life", halfLifeH } };
}

/** Body weight assumed when none has been synced or logged. */
export const DEFAULT_WEIGHT_KG = 75;
/** Grams of ethanol cleared per kg body weight per hour (~8 g/h at 75 kg). */
export const ALCOHOL_CLEARANCE_G_PER_KG_H = 0.11;
/**
 * Widmark's r: the share of body weight alcohol spreads through. ~0.68 for
 * men, ~0.55 for women; the app doesn't know which, so it splits the
 * difference and says so.
 */
export const WIDMARK_R = 0.6;
/** One Danish "genstand": 12 g of ethanol. */
export const GRAMS_PER_DRINK = 12;

export function alcoholKinetics(weightKg = DEFAULT_WEIGHT_KG): Kinetics {
  return {
    absorbHalfLifeH: 0.25,
    elimination: { kind: "steady", perHour: ALCOHOL_CLEARANCE_G_PER_KG_H * weightKg },
  };
}

/** Blood alcohol in ‰ (g per kg) for grams in the body. */
export function promille(grams: number, weightKg = DEFAULT_WEIGHT_KG): number {
  return grams / (WIDMARK_R * weightKg);
}

/**
 * Amount in the body every `stepMs` from `fromMs` to `toMs` (inclusive).
 *
 * Simulated rather than solved: two compartments — swallowed but not yet
 * absorbed, and in the blood — stepped forward in time. The same loop serves
 * both elimination kinds, and steady-rate clearance has no tidy closed form
 * once doses overlap.
 */
export function simulate(
  doses: Dose[],
  k: Kinetics,
  fromMs: number,
  toMs: number,
  stepMs = STEP_MS,
): Point[] {
  const sorted = doses.filter((d) => d.amount > 0 && isFinite(d.at)).sort((a, b) => a.at - b.at);
  const stepH = stepMs / HOUR_MS;
  const absorbed = 1 - Math.pow(0.5, stepH / k.absorbHalfLifeH);
  const keep =
    k.elimination.kind === "half-life" ? Math.pow(0.5, stepH / k.elimination.halfLifeH) : 1;
  const clear = k.elimination.kind === "steady" ? k.elimination.perHour * stepH : 0;

  // Start where the first dose went in, so earlier doses have had their
  // effect by the time the window opens.
  const first = sorted[0];
  let t = first ? Math.min(first.at, fromMs) : fromMs;
  t = fromMs - Math.ceil((fromMs - t) / stepMs) * stepMs;
  let gut = 0;
  let blood = 0;
  let i = 0;
  const out: Point[] = [];
  for (; t <= toMs; t += stepMs) {
    while (i < sorted.length && sorted[i]!.at <= t) gut += sorted[i++]!.amount;
    if (t >= fromMs) out.push({ t, amount: blood });
    const moved = gut * absorbed;
    gut -= moved;
    blood = Math.max(0, blood * keep + moved - clear);
  }
  return out;
}

/** The amount at one moment. */
export function levelAt(doses: Dose[], k: Kinetics, atMs: number): number {
  return simulate(doses, k, atMs, atMs)[0]?.amount ?? 0;
}

/**
 * The first moment after `fromMs` the level is under `threshold` and stays
 * there (nothing still being absorbed pushes it back up), within `horizonH`.
 * `fromMs` itself when it already is; null when it isn't within the horizon.
 */
export function whenBelow(
  doses: Dose[],
  k: Kinetics,
  threshold: number,
  fromMs: number,
  horizonH = 48,
): number | null {
  const series = simulate(doses, k, fromMs, fromMs + horizonH * HOUR_MS);
  let found: number | null = null;
  for (const p of series) {
    if (p.amount >= threshold) found = null;
    else if (found == null) found = p.t;
  }
  return found;
}

// ---------------------------------------------------------------------------
// Weeks: creatine and vitamin D
// ---------------------------------------------------------------------------

/**
 * Creatine: extra stored in muscle above what diet alone keeps there.
 *
 * Tuned to the studies people quote: 3 g a day tops the store up in about four
 * weeks, a 20 g "loading" week does it in five or six days, and after
 * stopping it drains back over four to six weeks. Muscle can only take up so
 * much in a day, which is why loading has a ceiling.
 */
export const CREATINE = {
  /** Extra capacity, g per kg body weight (~22 g at 75 kg). */
  capacityPerKg: 0.3,
  /** Share of a dose the muscle keeps while there's room. */
  uptake: 0.5,
  /** Most the store can gain in a day, g. */
  maxPerDay: 5,
  /** Half-life of the extra store once doses stop, days. */
  halfLifeDays: 10,
};

/** Vitamin D: 25(OH)D, the form a blood test measures. */
export const VITAMIN_D = {
  /** Half-life of 25(OH)D in the blood, days. */
  halfLifeDays: 15,
  /** nmol/L the blood level settles higher per µg taken daily. */
  nmolPerUgDaily: 1,
  /**
   * Where an unsupplemented northern-European level sits through the year
   * (sun, mostly): highest at the end of summer, lowest at the end of
   * winter. Danish population studies land around 70 nmol/L in late August
   * and 40 in late February. Without a blood test this stands in for
   * everything the diary can't see.
   */
  baselineMean: 55,
  baselineSwing: 15,
  /** Day of the year the baseline peaks (late August). */
  baselinePeakDoy: 240,
  /** ng/mL → nmol/L, for lab reports from places that use the former. */
  nmolPerNg: 2.496,
};

/**
 * What a 25(OH)D number means, by the usual cut-offs: under 30 nmol/L is a
 * deficiency, 50 is enough for bones (the Nordic and IOM line), 75 is the
 * higher target some guidelines aim for, and past 150 there is little more
 * to gain (harm starts well above, around 250).
 */
export const VITAMIN_D_BANDS = [
  { upTo: 30, key: "deficient", label: "Deficient" },
  { upTo: 50, key: "low", label: "Low" },
  { upTo: 75, key: "enough", label: "Enough" },
  { upTo: 150, key: "good", label: "Good" },
  { upTo: Infinity, key: "high", label: "High" },
] as const;
export type VitaminDBand = (typeof VITAMIN_D_BANDS)[number];
export const VITAMIN_D_ENOUGH = 50;
export const VITAMIN_D_TARGET = 75;

export function vitaminDBand(nmol: number): VitaminDBand {
  return VITAMIN_D_BANDS.find((b) => nmol < b.upTo) ?? VITAMIN_D_BANDS[VITAMIN_D_BANDS.length - 1]!;
}

function dayOfYear(ms: number): number {
  const d = new Date(ms);
  return (Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(d.getFullYear(), 0, 0)) / DAY_MS;
}

/** The unsupplemented level for the time of year at `ms`, nmol/L. */
export function vitaminDBaseline(ms: number): number {
  const angle = (2 * Math.PI * (dayOfYear(ms) - VITAMIN_D.baselinePeakDoy)) / 365;
  return VITAMIN_D.baselineMean + VITAMIN_D.baselineSwing * Math.cos(angle);
}

/** The lowest the baseline gets: late winter. */
export const VITAMIN_D_BASELINE_LOW = VITAMIN_D.baselineMean - VITAMIN_D.baselineSwing;

/**
 * µg a day that keep the level at or over `target` even at the bottom of
 * winter, given how far this person sits from the average (`offset`, from a
 * blood test; 0 without one). 0 when sun alone gets there.
 */
export function vitaminDUgFor(target: number, offset = 0): number {
  return Math.max(0, (target - VITAMIN_D_BASELINE_LOW - offset) / VITAMIN_D.nmolPerUgDaily);
}

/** Per-day totals: index 0 is the oldest day. */
export interface DailyStore {
  /** Value at the end of each day, oldest first. */
  series: number[];
  /** Today's value. */
  now: number;
}

/** Creatine store as a fraction 0..1 of full, day by day. */
export function creatineStore(dailyGrams: number[], weightKg = DEFAULT_WEIGHT_KG): DailyStore {
  const cap = CREATINE.capacityPerKg * weightKg;
  const keep = Math.pow(0.5, 1 / CREATINE.halfLifeDays);
  let store = 0;
  const series = dailyGrams.map((g) => {
    const gain = Math.min(CREATINE.maxPerDay, Math.max(0, g) * CREATINE.uptake);
    store = Math.min(cap, store * keep + gain);
    return store / cap;
  });
  return { series, now: series[series.length - 1] ?? 0 };
}

/**
 * Where the creatine store counts as working — the line the card draws, like
 * caffeine's sleep line. Studies see the benefit once the store is most of
 * the way to full; below that it's tapering off.
 */
export const CREATINE_WORKING = 0.7;

/**
 * Days from a store at `from` until it drops under `threshold` with no more
 * creatine. 0 when it's already under.
 */
export function creatineDaysUntilBelow(from: number, threshold = CREATINE_WORKING): number {
  if (from < threshold) return 0;
  const keep = Math.pow(0.5, 1 / CREATINE.halfLifeDays);
  return Math.floor(Math.log(threshold / from) / Math.log(keep)) + 1;
}

/**
 * Days until the creatine store is ≥ `target` full at `gramsPerDay`, or null
 * when that pace never gets there (within a year). 0 when it's there already.
 */
export function creatineDaysTo(
  from: number,
  gramsPerDay: number,
  target = 0.9,
  weightKg = DEFAULT_WEIGHT_KG,
): number | null {
  if (from >= target) return 0;
  const cap = CREATINE.capacityPerKg * weightKg;
  const keep = Math.pow(0.5, 1 / CREATINE.halfLifeDays);
  const gain = Math.min(CREATINE.maxPerDay, Math.max(0, gramsPerDay) * CREATINE.uptake);
  let store = from * cap;
  for (let d = 1; d <= 365; d++) {
    store = Math.min(cap, store * keep + gain);
    if (store / cap >= target) return d;
  }
  return null;
}

/**
 * How much logged vitamin D has raised the blood level, in nmol/L, day by
 * day. On top of sunlight and whatever the level was before — which the diary
 * can't see, so this is the part the logged intake accounts for, not the
 * level itself. A blood test is the only real number.
 */
export function vitaminDContribution(dailyUg: number[]): DailyStore {
  const keep = Math.pow(0.5, 1 / VITAMIN_D.halfLifeDays);
  let level = 0;
  const series = dailyUg.map((ug) => {
    level = level * keep + (1 - keep) * VITAMIN_D.nmolPerUgDaily * Math.max(0, ug);
    return level;
  });
  return { series, now: series[series.length - 1] ?? 0 };
}
