/**
 * The rest of the stores: everything on the Body tab beyond caffeine, alcohol,
 * creatine and vitamin D (those are in lib/bodyModel.ts).
 *
 * Three clocks again:
 *
 * - Hours to days: glycogen, the carbohydrate kept in liver and muscle. Carbs
 *   fill it, the brain drains the liver between meals, workouts drain the
 *   muscle. When the liver runs low the body turns to fat and ketones rise —
 *   the model predicts them too, which is how a ketone meter can check it,
 *   correct it, and over time teach it how fast this liver empties.
 * - Weeks to months: the omega-3 index, ferritin (stored iron), beta-alanine's
 *   muscle carnosine, and a handful of vitamin and mineral reserves.
 * - Training and sleep: fitness against fatigue from workouts, and sleep debt
 *   from synced nights. Not nutrients, but the same shape — something that
 *   builds up and drains away.
 *
 * Like the rest, these are textbook averages, not measurements. Where a blood
 * test or meter reading exists, it pins the model; where it doesn't, the
 * cards say they're estimates.
 *
 * Pure functions only; lib/body.ts feeds them.
 */
import { DAY_MS, DEFAULT_WEIGHT_KG, HOUR_MS } from "./bodyModel";
import type { Dose, Point } from "./bodyModel";

// ---------------------------------------------------------------------------
// Shared: bands, and a level that follows intake over weeks
// ---------------------------------------------------------------------------

/** A named range on a gauge: everything under `upTo` that isn't in an earlier one. */
export interface Band {
  upTo: number;
  key: string;
  label: string;
  /** How it reads: drives the colour. */
  tone: "bad" | "warn" | "ok" | "good";
}

export function bandOf<B extends Band>(bands: readonly B[], v: number): B {
  return bands.find((b) => v < b.upTo) ?? bands[bands.length - 1]!;
}

/**
 * Days with nothing logged at all are skipped (the level holds), so a day
 * you forgot to log doesn't read as a day you ate none of it. `null` = skip.
 */
export type DailyIntake = (number | null)[];

/** Mean of the logged days in `days`, or 0 when none were. */
export function meanLogged(days: DailyIntake): number {
  const logged = days.filter((d): d is number => d != null);
  return logged.length ? logged.reduce((a, b) => a + b, 0) / logged.length : 0;
}

/**
 * A level that moves toward `steady(intake)` with the given half-life, day
 * by day. It starts where the first month's intake would have kept it — the
 * diary can't see further back, and assuming the past looked like the start
 * beats assuming it was empty.
 */
export function follow(
  days: DailyIntake,
  halfLifeDays: number,
  steady: (perDay: number) => number,
  start?: number,
): number[] {
  const keep = Math.pow(0.5, 1 / halfLifeDays);
  let level = start ?? steady(meanLogged(days.slice(0, 30)));
  return days.map((d) => {
    if (d != null) level = level * keep + (1 - keep) * steady(d);
    return level;
  });
}

// ---------------------------------------------------------------------------
// Omega-3 index
// ---------------------------------------------------------------------------

/**
 * EPA + DHA as a share of the fatty acids in red-cell membranes — what an
 * omega-3 index test measures. Red cells live about 120 days, so it follows
 * intake over months.
 *
 * Without fish or fish oil most Western diets sit around 4%; each gram a day
 * of EPA + DHA settles it roughly 3.5 points higher (Flock et al. 2013 and
 * the dose-response studies around it). 8% and over is the usual target.
 */
export const OMEGA3 = {
  baselinePct: 4,
  pctPerGDaily: 3.5,
  maxPct: 14,
  halfLifeDays: 35,
  scaleMax: 12,
};

export const OMEGA3_BANDS: readonly Band[] = [
  { upTo: 4, key: "low", label: "Low", tone: "bad" },
  { upTo: 8, key: "mid", label: "Intermediate", tone: "warn" },
  { upTo: Infinity, key: "target", label: "On target", tone: "good" },
];
export const OMEGA3_TARGET = 8;

export function omega3Steady(gPerDay: number): number {
  return Math.min(OMEGA3.maxPct, OMEGA3.baselinePct + OMEGA3.pctPerGDaily * Math.max(0, gPerDay));
}

/** g of EPA + DHA a day that settle the index at `pct`. */
export function omega3GramsFor(pct: number, offset = 0): number {
  return Math.max(0, (pct - offset - OMEGA3.baselinePct) / OMEGA3.pctPerGDaily);
}

export function omega3Index(days: DailyIntake): number[] {
  return follow(days, OMEGA3.halfLifeDays, omega3Steady);
}

// ---------------------------------------------------------------------------
// Ferritin
// ---------------------------------------------------------------------------

/**
 * Ferritin (µg/L) tracks the iron kept in store: each µg/L is roughly 8 mg
 * of it. The body absorbs more iron when the store is low and less when it's
 * full (hepcidin), which is what keeps most people from running empty or
 * filling up — so absorption here slides from ~17% at a ferritin of 30 down
 * to ~7% at 300. The store loses ~1.2 mg a day (skin, gut; more with periods,
 * which the app can't know).
 *
 * The least certain card: iron absorption depends on what it's eaten with,
 * and not every logged food has its iron estimated.
 */
export const FERRITIN = {
  mgPerUgL: 8,
  lossMgPerDay: 1.2,
  absorbFloor: 0.05,
  absorbSwing: 0.25,
  absorbHalfAt: 30,
  scaleMax: 300,
};

export const FERRITIN_BANDS: readonly Band[] = [
  { upTo: 30, key: "low", label: "Low", tone: "bad" },
  { upTo: 50, key: "borderline", label: "Borderline", tone: "warn" },
  { upTo: 200, key: "good", label: "Good", tone: "good" },
  { upTo: 300, key: "upper", label: "Upper normal", tone: "ok" },
  { upTo: Infinity, key: "high", label: "High", tone: "warn" },
];

function ironAbsorbed(mg: number, ferritin: number): number {
  const share =
    FERRITIN.absorbFloor +
    (FERRITIN.absorbSwing * FERRITIN.absorbHalfAt) / (FERRITIN.absorbHalfAt + Math.max(0, ferritin));
  return Math.max(0, mg) * share;
}

/** Where ferritin settles at a steady daily iron intake. */
export function ferritinSteady(mgPerDay: number): number {
  // Absorbed = loss, solved for ferritin.
  const share = FERRITIN.lossMgPerDay / Math.max(1e-6, mgPerDay);
  const above = share - FERRITIN.absorbFloor;
  if (above <= 0) return 600;
  return Math.min(600, Math.max(5, (FERRITIN.absorbSwing * FERRITIN.absorbHalfAt) / above - FERRITIN.absorbHalfAt));
}

/** mg of iron a day that settle ferritin at `target`. */
export function ironFor(target: number): number {
  const share =
    FERRITIN.absorbFloor + (FERRITIN.absorbSwing * FERRITIN.absorbHalfAt) / (FERRITIN.absorbHalfAt + target);
  return FERRITIN.lossMgPerDay / share;
}

/**
 * Ferritin day by day. `start` is the level on day 0 (a blood test, or where
 * the first month's intake settles); `pinAt` re-sets it to a test result on
 * that index.
 */
export function ferritinSeries(days: DailyIntake, start?: number, pinAt?: { i: number; value: number }): number[] {
  let f = start ?? ferritinSteady(meanLogged(days.slice(0, 30)));
  return days.map((mg, i) => {
    if (mg != null) f = Math.max(1, f + (ironAbsorbed(mg, f) - FERRITIN.lossMgPerDay) / FERRITIN.mgPerUgL);
    if (pinAt && i === pinAt.i) f = pinAt.value;
    return f;
  });
}

// ---------------------------------------------------------------------------
// Beta-alanine
// ---------------------------------------------------------------------------

/**
 * Beta-alanine raises muscle carnosine, the buffer behind the "burn" in
 * hard 1–4 minute efforts. 4–6 g a day lifts carnosine ~40–60% in four weeks
 * and ~60–80% by ten; stop and it drifts back over three to four months.
 * Shown as a share of the most it can rise (~80%).
 */
export const BETA_ALANINE = {
  /** Fraction of the remaining room each gram fills. */
  perGram: 0.006,
  halfLifeDays: 50,
  /** Carnosine rise, %, at a full store. */
  maxRisePct: 80,
};
/** Roughly where studies start seeing the benefit: +40% carnosine. */
export const BETA_ALANINE_WORKING = 0.5;

export function betaAlanineStore(dailyGrams: number[]): number[] {
  const keep = Math.pow(0.5, 1 / BETA_ALANINE.halfLifeDays);
  let s = 0;
  return dailyGrams.map((g) => {
    const fill = 1 - Math.exp(-BETA_ALANINE.perGram * Math.max(0, g));
    s = Math.min(1, s * keep + (1 - s * keep) * fill);
    return s;
  });
}

// ---------------------------------------------------------------------------
// Vitamin and mineral reserves
// ---------------------------------------------------------------------------

/**
 * Smaller reserves, shown as one row each: how full, where 100% is what
 * meeting the daily reference intake keeps it at. Each follows intake with
 * the half-life of where the body keeps it — red cells for folate, the
 * thyroid for iodine, the liver for A and B12, fat for E — so K (barely
 * stored) moves daily and B12 hardly at all.
 */
export interface ReserveDef {
  key: "folate_ug" | "iodine_ug" | "vitamin_b12_ug" | "vitamin_a_ug" | "vitamin_e_mg" | "vitamin_k_ug";
  label: string;
  glyph: string;
  ref: number;
  halfLifeDays: number;
  where: string;
  /** Turns a day's intake into what counts toward the store (B12 saturates). */
  effective?: (amount: number) => number;
}

export const RESERVES: ReserveDef[] = [
  { key: "folate_ug", label: "Folate", glyph: "🥬", ref: 400, halfLifeDays: 40, where: "red blood cells, about four months" },
  { key: "iodine_ug", label: "Iodine", glyph: "🧂", ref: 150, halfLifeDays: 60, where: "the thyroid, a few months" },
  {
    key: "vitamin_b12_ug",
    label: "B12",
    glyph: "🥩",
    ref: 2.4,
    halfLifeDays: 400,
    where: "the liver, years",
    // Gut uptake saturates at a few µg a meal; above that only ~1% gets in,
    // which is why B12 pills are 250–1000 µg.
    effective: (ug) => Math.min(ug, 5) + Math.max(0, ug - 5) * 0.015,
  },
  { key: "vitamin_a_ug", label: "Vitamin A", glyph: "🥕", ref: 900, halfLifeDays: 150, where: "the liver, months to years" },
  { key: "vitamin_e_mg", label: "Vitamin E", glyph: "🌻", ref: 15, halfLifeDays: 200, where: "body fat, many months" },
  { key: "vitamin_k_ug", label: "Vitamin K", glyph: "🥦", ref: 120, halfLifeDays: 3, where: "barely — a few days" },
];

/** Above this a reserve is just full; more doesn't show. */
export const RESERVE_CAP = 1.5;

export const RESERVE_BANDS: readonly Band[] = [
  { upTo: 0.5, key: "low", label: "Low", tone: "bad" },
  { upTo: 0.9, key: "part", label: "Partly full", tone: "warn" },
  { upTo: Infinity, key: "full", label: "Full", tone: "good" },
];

/** A reserve, 0..RESERVE_CAP of full, day by day. */
export function reserveSeries(def: ReserveDef, days: DailyIntake): number[] {
  const eff = def.effective ?? ((v: number) => v);
  return follow(days, def.halfLifeDays, (amount) => Math.min(RESERVE_CAP, eff(amount) / def.ref));
}

// ---------------------------------------------------------------------------
// Glycogen
// ---------------------------------------------------------------------------

/**
 * Carbohydrate stored as glycogen: ~100 g in the liver, which keeps blood
 * sugar up between meals, and ~6 g per kg of body weight in muscle, which
 * only the muscle itself can use.
 *
 * Every 15 minutes: eaten carbs are absorbed (half in ~45 min) and first
 * cover the ~5 g an hour the brain and blood need; what's left goes to the
 * stores. With nothing coming in, the liver covers that need — less and less
 * as it empties and gluconeogenesis takes over, which is why an overnight
 * fast leaves it about half full and a day-long one nearly empty. Workouts
 * burn carbohydrate (more at high intensity than in zone 2), mostly out of
 * the muscle. Under ~30% liver the body leans on fat and ketones climb.
 *
 * Muscle only moves two ways: a workout takes carbohydrate out of it, and a
 * carb surplus puts it back — faster the emptier it is (a drained muscle
 * pulls glucose in on its own for a few hours, and stays more sensitive to
 * insulin for a day), so a hard session is made good in about a day of
 * eating plenty of carbs and two of eating normally. Rest and fasting leave it
 * alone: muscle can't hand its glycogen back to the blood.
 */
export const GLYCOGEN = {
  liverCapG: 100,
  musclePerKg: 6,
  absorbHalfLifeH: 0.75,
  /** What the brain and blood draw, g/h. */
  demandGPerH: 5,
  /** Fastest muscle can refill, g/h: when it's full, and the extra when empty. */
  muscleMaxGPerH: 8,
  muscleMaxExtraGPerH: 16,
  /** Share of a surplus the liver takes first. */
  liverShare: 0.35,
  /** Share of workout energy from carbohydrate, by intensity. */
  carbShareHard: 0.65,
  carbShareZone2: 0.3,
  /** For a whole session Garmin called low aerobic / anaerobic, with no zone minutes. */
  carbShareLow: 0.35,
  carbShareAnaerobic: 0.8,
  /** Share of workout carbohydrate that comes out of the blood (liver). */
  workoutFromLiver: 0.2,
  /** Workouts with no duration are taken as this long, min. */
  defaultWorkoutMin: 45,
  stepMs: 15 * 60_000,
};
/** Under this share of liver glycogen, ketones are expected to rise. */
export const LIVER_KETOSIS = 0.3;

/**
 * Blood β-ketones, as the liver's glycogen predicts them. With a well-stocked
 * liver they sit at a fed baseline; from a bit above the ketosis line down
 * they climb toward a ceiling that is higher the emptier the liver, slowly —
 * so they pass 0.5 mmol/L around the time the liver passes that line, and a
 * fast reads about
 * 0.3–0.8 mmol/L at a day, 1.5–2.5 at two, 3–4 at three (Cahill's starvation
 * curves). Carbs coming in shut ketone production off within a couple of
 * hours, well before the liver has refilled.
 *
 * This is what makes a meter reading a check on the model rather than just a
 * correction to it: the model says what the strip should show, the strip says
 * what it did, and the gap is what the personal drain rate is fitted from.
 */
export const KETONES = {
  baseMmol: 0.1,
  /** Where a fast of many days levels off. */
  maxMmol: 5,
  /** Liver share under which they start to creep up. */
  onsetLiver: 0.45,
  riseTauH: 36,
  fallTauH: 2,
};

export interface WorkoutBurn {
  /** Epoch ms it started. */
  at: number;
  durationMin: number | null;
  kcal: number;
  zone2Min: number | null;
  /** Garmin's training load for the activity, when the watch recorded it. */
  garminLoad?: number | null;
  /** Which kind of load it was, when Garmin's numbers say (see focusOf). */
  focus?: LoadFocus | null;
}

export interface MeterReading {
  at: number;
  /** mmol/L. */
  value: number;
}

/**
 * One sitting at the meter: a ketone strip, a glucose strip, or both taken
 * together (within half an hour). mmol/L.
 */
export interface FuelReading {
  at: number;
  ketone: number | null;
  glucose: number | null;
}

export interface GlycogenPoint {
  t: number;
  /** 0..1 of a full store. */
  liver: number;
  muscle: number;
  /** Predicted blood ketones, mmol/L. */
  ketone: number;
}

/** What a reading did to the model when it arrived. */
export interface ReadingCheck {
  reading: FuelReading;
  /** Ketones the model expected at that moment, mmol/L. */
  predictedKetone: number;
  /** Liver, 0..1, before and after the reading was taken into account. */
  liverBefore: number;
  liverAfter: number;
}

/** How a muscle store reads, by how full it is. */
export const MUSCLE_BANDS: readonly Band[] = [
  { upTo: 0.3, key: "low", label: "Low — hard efforts will fade early", tone: "bad" },
  { upTo: 0.5, key: "drawn", label: "Drawn down", tone: "warn" },
  { upTo: 0.8, key: "ready", label: "Ready for a normal session", tone: "ok" },
  { upTo: Infinity, key: "full", label: "Topped up", tone: "good" },
];

/** Share of a workout's energy that comes from carbohydrate. */
export function carbShareOf(w: WorkoutBurn, min: number): number {
  const g = GLYCOGEN;
  if (w.zone2Min == null && w.focus === "low") return g.carbShareLow;
  if (w.zone2Min == null && w.focus === "anaerobic") return g.carbShareAnaerobic;
  const z2 = Math.min(min, Math.max(0, w.zone2Min ?? 0));
  const hard = w.focus === "anaerobic" ? g.carbShareAnaerobic : g.carbShareHard;
  return (z2 * g.carbShareZone2 + (min - z2) * hard) / min;
}

/** Grams of carbohydrate a workout takes out of muscle (the rest is the liver's). */
export function muscleCostG(w: WorkoutBurn): number {
  const min = w.durationMin && w.durationMin > 0 ? w.durationMin : GLYCOGEN.defaultWorkoutMin;
  return ((Math.max(0, w.kcal) * carbShareOf(w, min)) / 4) * (1 - GLYCOGEN.workoutFromLiver);
}

/** Linear interpolation through `pts` (x ascending), flat beyond the ends. */
function interp(pts: readonly (readonly [number, number])[], x: number): number {
  const first = pts[0]!;
  if (x <= first[0]) return first[1];
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = pts[i]!;
    const [x0, y0] = pts[i - 1]!;
    if (x <= x1) return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
  }
  return pts[pts.length - 1]![1];
}

/** The most liver (0..1) a ketone reading of at least 0.3 mmol/L allows. */
const LIVER_CEILING = [
  [0.3, 0.4],
  [0.5, 0.25],
  [1, 0.12],
  [1.5, 0.05],
  [3, 0],
] as const;
/** The least liver (0..1) a ketone reading under 0.3 mmol/L allows. */
const LIVER_FLOOR = [
  [0, 0.4],
  [0.3, 0.3],
] as const;

/** A workout this recently can raise ketones by itself. */
const POST_WORKOUT_H = 3;

/**
 * What a reading says about the liver: a ceiling or a floor (0..1), and how
 * far to trust it (0..1 — the share of the way the model moves to meet it).
 *
 * Ketones carry the signal. Glucose can't on its own — the body holds it
 * steady whether the liver is full or half empty — but taken with the ketone
 * strip it says how much to believe it: raised ketones with low glucose is
 * the fasting picture and counts in full; raised ketones with high glucose is
 * something else (a meal just eaten, MCT oil, ketone salts) and counts for
 * less. A workout in the last few hours raises ketones too, so it also takes
 * some weight off. A glucose strip alone only speaks when it reads low: the
 * liver isn't keeping up, so it's probably near empty.
 */
export function liverEvidence(
  r: FuelReading,
  hoursSinceWorkout: number | null = null,
): { ceiling?: number; floor?: number; weight: number } | null {
  const k = r.ketone;
  const g = r.glucose;
  if (k == null) {
    return g != null && g < 3.9 ? { ceiling: 0.25, weight: 0.5 } : null;
  }
  if (k < 0.3) {
    return { floor: interp(LIVER_FLOOR, k), weight: g != null && g >= 4.4 ? 1 : 0.8 };
  }
  let weight = g == null ? 0.8 : g < 4.4 ? 1 : g > 6 ? 0.4 : 0.8;
  if (hoursSinceWorkout != null && hoursSinceWorkout < POST_WORKOUT_H) weight *= 0.7;
  return { ceiling: interp(LIVER_CEILING, k), weight };
}

export interface GlycogenInput {
  /** Net carbs eaten, g. */
  carbs: Dose[];
  workouts: WorkoutBurn[];
  readings: FuelReading[];
  fromMs: number;
  toMs: number;
  /** Where the simulation starts, before the window opens. */
  warmupFromMs: number;
  weightKg?: number;
  /**
   * How fast this liver empties against the textbook's (1 = the same): the
   * personal number fitDrain works out from past readings.
   */
  drain?: number;
  /** False runs it blind to the readings: what the model alone would say. */
  pin?: boolean;
  /** From when to add up what went in and out of muscle (default: `fromMs`). */
  ledgerFromMs?: number;
}

export interface GlycogenRun {
  points: GlycogenPoint[];
  /** Each reading inside the window, with what the model expected. */
  checks: ReadingCheck[];
  /** Grams workouts took out of muscle and carbs put back, since `ledgerFromMs`. */
  muscleBurnedG: number;
  muscleRefilledG: number;
  /** A full muscle store, g. */
  muscleCapG: number;
}

/**
 * Glycogen and the ketones it predicts from `fromMs` to `toMs`, every 15
 * minutes. Starts at `warmupFromMs` at a typical fed state, so the window
 * opens on something carbs and workouts have already shaped.
 *
 * A reading pulls the liver toward what it implies (liverEvidence) and sets
 * the ketone level to what the strip showed.
 */
export function simulateGlycogen(input: GlycogenInput): GlycogenRun {
  const { fromMs, toMs, warmupFromMs, weightKg = DEFAULT_WEIGHT_KG, drain = 1, pin = true } = input;
  const g = GLYCOGEN;
  const stepH = g.stepMs / HOUR_MS;
  const liverCap = g.liverCapG;
  const muscleCap = g.musclePerKg * weightKg;
  const absorbed = 1 - Math.pow(0.5, stepH / g.absorbHalfLifeH);
  const rise = 1 - Math.exp(-stepH / KETONES.riseTauH);
  const fall = 1 - Math.exp(-stepH / KETONES.fallTauH);

  const doses = input.carbs.filter((d) => d.amount > 0 && d.at <= toMs).sort((a, b) => a.at - b.at);
  const reads = pin ? input.readings.filter((r) => r.at <= toMs).sort((a, b) => a.at - b.at) : [];
  // Per-step carbohydrate burn from workouts, spread over each one.
  const burns = input.workouts
    .map((w) => {
      const min = w.durationMin && w.durationMin > 0 ? w.durationMin : g.defaultWorkoutMin;
      const carbG = (Math.max(0, w.kcal) * carbShareOf(w, min)) / 4;
      return { start: w.at, end: w.at + min * 60_000, perStep: (carbG * g.stepMs) / (min * 60_000) };
    })
    .sort((a, b) => a.start - b.start);

  let t = Math.min(warmupFromMs, fromMs);
  t = fromMs - Math.ceil((fromMs - t) / g.stepMs) * g.stepMs;
  let gut = 0;
  let liver = 0.7 * liverCap;
  let muscle = 0.8 * muscleCap;
  let ketone = KETONES.baseMmol;
  let di = 0;
  let ri = 0;
  /** First workout that hasn't ended yet, and the end of the last that has. */
  let bi = 0;
  let lastWorkoutEnd: number | null = null;
  const points: GlycogenPoint[] = [];
  const checks: ReadingCheck[] = [];
  const ledgerFrom = input.ledgerFromMs ?? fromMs;
  let muscleBurnedG = 0;
  let muscleRefilledG = 0;
  for (; t <= toMs; t += g.stepMs) {
    while (di < doses.length && doses[di]!.at <= t) gut += doses[di++]!.amount;
    while (bi < burns.length && burns[bi]!.end <= t) lastWorkoutEnd = Math.max(lastWorkoutEnd ?? 0, burns[bi++]!.end);
    while (ri < reads.length && reads[ri]!.at <= t) {
      const r = reads[ri++]!;
      const before = liver / liverCap;
      const sinceWorkout =
        bi < burns.length && burns[bi]!.start <= r.at
          ? 0
          : lastWorkoutEnd != null
            ? (r.at - lastWorkoutEnd) / HOUR_MS
            : null;
      const ev = liverEvidence(r, sinceWorkout);
      if (ev) {
        const target =
          ev.ceiling != null ? Math.min(before, ev.ceiling) : Math.max(before, ev.floor ?? before);
        liver = (before + (target - before) * ev.weight) * liverCap;
      }
      if (r.at >= fromMs) {
        checks.push({ reading: r, predictedKetone: ketone, liverBefore: before, liverAfter: liver / liverCap });
      }
      if (r.ketone != null) ketone = r.ketone;
    }
    if (t >= fromMs) points.push({ t, liver: liver / liverCap, muscle: muscle / muscleCap, ketone });

    const inflow = gut * absorbed;
    gut -= inflow;
    const demand = g.demandGPerH * stepH;
    const fed = inflow >= demand;
    if (fed) {
      let surplus = inflow - demand;
      const toLiver = Math.min(surplus * g.liverShare, liverCap - liver);
      liver += toLiver;
      surplus -= toLiver;
      const room = 1 - muscle / muscleCap;
      const toMuscle = Math.min(
        surplus,
        (g.muscleMaxGPerH + g.muscleMaxExtraGPerH * room) * stepH,
        muscleCap - muscle,
      );
      muscle += toMuscle;
      if (t >= ledgerFrom) muscleRefilledG += toMuscle;
      surplus -= toMuscle;
      liver += Math.min(surplus, liverCap - liver);
    } else {
      // The liver covers the gap less as it empties; gluconeogenesis the rest.
      liver = Math.max(0, liver - (demand - inflow) * drain * Math.sqrt(liver / liverCap));
    }
    for (let i = bi; i < burns.length; i++) {
      const b = burns[i]!;
      if (b.start > t) break;
      if (t >= b.end) continue;
      const fromLiver = b.perStep * g.workoutFromLiver;
      const fromMuscle = b.perStep - fromLiver;
      const m = Math.min(muscle, fromMuscle);
      muscle -= m;
      if (t >= ledgerFrom) muscleBurnedG += m;
      liver = Math.max(0, liver - (fromLiver + (fromMuscle - m)) * Math.sqrt(liver / liverCap));
    }

    const lf = liver / liverCap;
    const goal =
      fed || lf >= KETONES.onsetLiver
        ? KETONES.baseMmol
        : KETONES.baseMmol + (KETONES.maxMmol - KETONES.baseMmol) * (1 - lf / KETONES.onsetLiver);
    ketone += (goal - ketone) * (goal > ketone ? rise : fall);
  }
  return { points, checks, muscleBurnedG, muscleRefilledG, muscleCapG: muscleCap };
}

/** First point at or after `fromMs` where the liver is under `threshold`, or null. */
export function liverBelowAt(points: GlycogenPoint[], fromMs: number, threshold = LIVER_KETOSIS): number | null {
  for (const p of points) if (p.t >= fromMs && p.liver < threshold) return p.t;
  return null;
}

export function liverSeries(points: GlycogenPoint[]): Point[] {
  return points.map((p) => ({ t: p.t, amount: p.liver * 100 }));
}

export function ketoneSeries(points: GlycogenPoint[]): Point[] {
  return points.map((p) => ({ t: p.t, amount: p.ketone }));
}

/** The personal drain rate, and how many readings it was fitted to. */
export interface DrainFit {
  /** Against the textbook: 1.2 = this liver empties 20% faster. */
  drain: number;
  used: number;
}

/** Drain rates tried, slowest to fastest. */
const DRAIN_CANDIDATES = [0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6];
/** Fewer ketone readings than this say too little to fit anything to. */
export const DRAIN_FIT_MIN_READINGS = 3;
/** How hard the fit is held to the textbook: a few readings barely move it. */
const DRAIN_PRIOR = 1.5;

/**
 * How fast this person's liver empties, from their own ketone readings: the
 * model is run blind over the history at each candidate rate, and the one
 * whose predicted ketones sit closest to what the meter showed wins — held
 * toward the textbook, so it takes several readings that agree to move it.
 * Errors are compared on a log scale (0.1 against 0.4 matters as much as 1
 * against 3).
 *
 * `readings` should only be ones the diary can account for: a reading after
 * days with nothing logged looks like a fast to the model when it wasn't.
 * Null with too few of them.
 */
export function fitDrain(input: Omit<GlycogenInput, "readings" | "drain" | "pin">, readings: FuelReading[]): DrainFit | null {
  const used = readings.filter(
    (r): r is FuelReading & { ketone: number } => r.ketone != null && r.at >= input.fromMs && r.at <= input.toMs,
  );
  if (used.length < DRAIN_FIT_MIN_READINGS) return null;
  const squash = (k: number) => Math.log(Math.max(0, k) + 0.2);
  let best = 1;
  let bestCost = Infinity;
  for (const drain of DRAIN_CANDIDATES) {
    const { points } = simulateGlycogen({ ...input, readings: [], drain, pin: false });
    const first = points[0];
    if (!first) return null;
    let cost = DRAIN_PRIOR * Math.log(drain) ** 2;
    for (const r of used) {
      const p = points[Math.min(points.length - 1, Math.max(0, Math.round((r.at - first.t) / GLYCOGEN.stepMs)))]!;
      cost += (squash(p.ketone) - squash(r.ketone)) ** 2;
    }
    // Ties go to the rate nearest the textbook.
    if (cost < bestCost - 1e-9 || (Math.abs(cost - bestCost) <= 1e-9 && Math.abs(drain - 1) < Math.abs(best - 1))) {
      best = drain;
      bestCost = cost;
    }
  }
  return { drain: best, used: used.length };
}

// ---------------------------------------------------------------------------
// Training load
// ---------------------------------------------------------------------------

/**
 * Fitness and fatigue, the way Garmin reads them: each day's training load
 * folds into a long average (4 weeks, "chronic") and a short one (1 week,
 * "acute"). A workout's load is Garmin's own — its heart-rate based training
 * load for the activity, the number the watch adds up — and a workout that
 * has none (logged by hand) counts by its energy instead, in tens of kcal: a
 * one-hour 600 kcal ride is 60, which sits on roughly the same scale.
 *
 * Both are kept as daily averages; times 7 they read as Garmin's weekly acute
 * and chronic load. Their ratio (acute ÷ chronic) is the readable part: 0.8–1.3
 * is building steadily, over 1.5 is a jump the body hasn't been prepared for,
 * under 0.8 is easing off.
 */
export const TRAINING = {
  /** Garmin's chronic load window. */
  fitnessDays: 28,
  fatigueDays: 7,
  kcalPerLoad: 10,
  /** Under this fitness (daily load) there isn't enough history to read a ratio. */
  minFitness: 5,
  /** Daily averages × this = Garmin's weekly acute/chronic load. */
  weekly: 7,
};

export const TRAINING_BANDS: readonly Band[] = [
  { upTo: 0.8, key: "easing", label: "Easing off", tone: "ok" },
  { upTo: 1.3, key: "building", label: "Building", tone: "good" },
  { upTo: 1.5, key: "pushing", label: "Pushing", tone: "warn" },
  { upTo: Infinity, key: "spike", label: "Spike — injury risk", tone: "bad" },
];

export interface TrainingDay {
  fitness: number;
  fatigue: number;
}

export function trainingLoad(dailyLoad: number[]): TrainingDay[] {
  const kf = 1 - Math.exp(-1 / TRAINING.fitnessDays);
  const ka = 1 - Math.exp(-1 / TRAINING.fatigueDays);
  let fitness = 0;
  let fatigue = 0;
  return dailyLoad.map((l) => {
    fitness += (l - fitness) * kf;
    fatigue += (l - fatigue) * ka;
    return { fitness, fatigue };
  });
}

/** A workout's training load: Garmin's when it has one, else its energy. */
export function loadOf(w: WorkoutBurn): number {
  if (w.garminLoad != null && isFinite(w.garminLoad)) return Math.max(0, w.garminLoad);
  return Math.max(0, w.kcal) / TRAINING.kcalPerLoad;
}

/**
 * Load focus: the kind of training a workout's load was, in Garmin's three
 * groups — low aerobic (easy, base), high aerobic (tempo to VO2 max) and
 * anaerobic (sprints, hard intervals). A balanced month has plenty of the
 * first, a good share of the second and some of the third.
 */
export type LoadFocus = "low" | "high" | "anaerobic";

export const LOAD_FOCUS: { key: LoadFocus; label: string }[] = [
  { key: "low", label: "Low aerobic" },
  { key: "high", label: "High aerobic" },
  { key: "anaerobic", label: "Anaerobic" },
];

/** Garmin's primary-benefit labels, by the group they train. */
const FOCUS_BY_LABEL: Record<string, LoadFocus> = {
  RECOVERY: "low",
  AEROBIC_BASE: "low",
  TEMPO: "high",
  LACTATE_THRESHOLD: "high",
  VO2MAX: "high",
  ANAEROBIC_CAPACITY: "anaerobic",
  SPRINT: "anaerobic",
};

/** Anaerobic Training Effect from which a session counts as anaerobic. */
const ANAEROBIC_TE = 2;

/**
 * Which group a workout's load goes in, from what Garmin said about it: its
 * primary-benefit label first (that's what Garmin itself goes by), then the
 * anaerobic Training Effect, then time in heart-rate zones (mostly zone 3 and
 * up is high aerobic), then the aerobic Training Effect. Null when there's
 * nothing to go on — a workout logged by hand.
 */
export function focusOf(g: {
  teLabel: string | null;
  aerobicTe: number | null;
  anaerobicTe: number | null;
  zoneSecs: number[] | null;
}): LoadFocus | null {
  const label = g.teLabel?.toUpperCase().replace(/_\d+$/, "");
  if (label) {
    const known = FOCUS_BY_LABEL[label];
    if (known) return known;
    if (label.startsWith("ANAEROBIC")) return "anaerobic";
  }
  if (g.anaerobicTe != null && g.anaerobicTe >= ANAEROBIC_TE) return "anaerobic";
  const zones = g.zoneSecs ?? [];
  const total = zones.reduce((a, b) => a + Math.max(0, b), 0);
  if (total > 0) {
    const hard = zones.slice(2).reduce((a, b) => a + Math.max(0, b), 0);
    return hard / total >= 0.5 ? "high" : "low";
  }
  if (g.aerobicTe != null) return g.aerobicTe >= 3 ? "high" : "low";
  return null;
}

/** Each group's load over the workouts given, plus what couldn't be placed. */
export function focusTotals(
  workouts: WorkoutBurn[],
): Record<LoadFocus, number> & { unplaced: number } {
  const out = { low: 0, high: 0, anaerobic: 0, unplaced: 0 };
  for (const w of workouts) {
    const l = loadOf(w);
    if (w.focus) out[w.focus] += l;
    else out.unplaced += l;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sleep debt
// ---------------------------------------------------------------------------

/**
 * Hours of sleep owed: each night short of your need adds to it, longer
 * nights pay it back, and old debt fades (half in about five nights) — a bad night
 * three weeks ago isn't still costing you. Nights with no sleep synced are
 * left out rather than counted as zero.
 */
export const SLEEP = {
  defaultNeedH: 8,
  needs: [7, 7.5, 8, 8.5, 9] as const,
  halfLifeNights: 5,
};

export const SLEEP_BANDS: readonly Band[] = [
  { upTo: 3, key: "rested", label: "Rested", tone: "good" },
  { upTo: 6, key: "some", label: "Some debt", tone: "ok" },
  { upTo: 10, key: "debt", label: "In debt", tone: "warn" },
  { upTo: Infinity, key: "heavy", label: "Heavy debt", tone: "bad" },
];

/** Debt in hours after each night; `null` nights (no data) only fade it. */
export function sleepDebt(nightsH: (number | null)[], needH: number): number[] {
  const keep = Math.pow(0.5, 1 / SLEEP.halfLifeNights);
  let debt = 0;
  return nightsH.map((h) => {
    debt *= keep;
    if (h != null) debt = Math.max(0, debt + needH - h);
    return debt;
  });
}

export { DAY_MS };
