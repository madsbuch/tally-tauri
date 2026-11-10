import { describe, expect, test } from "bun:test";
import {
  DRAIN_FIT_MIN_READINGS,
  fitDrain,
  liverEvidence,
  muscleCostG,
  simulateGlycogen,
} from "../src/lib/storeModels";
import type { FuelReading, GlycogenPoint } from "../src/lib/storeModels";
import type { Dose } from "../src/lib/bodyModel";

const H = 3_600_000;
const T0 = Date.UTC(2026, 0, 1, 7);

/** Three 90 g carb meals a day (8:00, 13:00, 19:00 on T0's clock) for `days`. */
function meals(days: number, from = T0): Dose[] {
  const out: Dose[] = [];
  for (let d = 0; d < days; d++) {
    for (const h of [1, 6, 12]) out.push({ at: from + d * 24 * H + h * H, amount: 90 });
  }
  return out;
}

const at = (points: GlycogenPoint[], t: number) => points.filter((p) => p.t <= t).pop()!;

/** Two fed days, then nothing: the fast starts at the last meal. */
function fast(hours: number, opts: { drain?: number; readings?: FuelReading[]; pin?: boolean } = {}) {
  const carbs = meals(2);
  const lastMeal = carbs[carbs.length - 1]!.at;
  const run = simulateGlycogen({
    carbs,
    workouts: [],
    readings: opts.readings ?? [],
    fromMs: T0,
    toMs: lastMeal + hours * H,
    warmupFromMs: T0,
    weightKg: 75,
    drain: opts.drain,
    pin: opts.pin,
  });
  return { ...run, lastMeal };
}

describe("predicted ketones", () => {
  test("stay at baseline while eating normally", () => {
    const { points } = simulateGlycogen({
      carbs: meals(4),
      workouts: [],
      readings: [],
      fromMs: T0,
      toMs: T0 + 4 * 24 * H,
      warmupFromMs: T0,
    });
    expect(Math.max(...points.map((p) => p.ketone))).toBeLessThan(0.3);
  });

  test("climb through a fast the way a meter shows it", () => {
    const { points, lastMeal } = fast(72);
    const k = (h: number) => at(points, lastMeal + h * H).ketone;
    expect(k(12)).toBeLessThan(0.3);
    expect(k(24)).toBeGreaterThan(0.2);
    expect(k(24)).toBeLessThan(1);
    expect(k(48)).toBeGreaterThan(1.2);
    expect(k(48)).toBeLessThan(3);
    expect(k(72)).toBeGreaterThan(2.5);
    expect(k(72)).toBeLessThan(4.5);
  });

  test("fall within hours of carbs", () => {
    const carbs = [...meals(2), { at: T0 + 2 * 24 * H + 60 * H, amount: 80 }];
    const refeed = carbs[carbs.length - 1]!.at;
    const { points } = simulateGlycogen({
      carbs,
      workouts: [],
      readings: [],
      fromMs: T0,
      toMs: refeed + 6 * H,
      warmupFromMs: T0,
    });
    expect(at(points, refeed).ketone).toBeGreaterThan(1);
    expect(at(points, refeed + 4 * H).ketone).toBeLessThan(at(points, refeed).ketone / 2);
  });
});

describe("readings", () => {
  test("a high ketone reading pulls the liver down and resets the ketone level", () => {
    const carbs = meals(2);
    const t = carbs[carbs.length - 1]!.at + 6 * H;
    const { points, checks } = fast(8, { readings: [{ at: t, ketone: 1.5, glucose: 4.0 }] });
    expect(checks).toHaveLength(1);
    expect(checks[0]!.predictedKetone).toBeLessThan(0.3);
    expect(checks[0]!.liverBefore).toBeGreaterThan(0.5);
    expect(checks[0]!.liverAfter).toBeLessThan(0.1);
    expect(at(points, t + H).ketone).toBeGreaterThan(1.3);
  });

  test("a low ketone reading lifts a liver the model had empty", () => {
    const carbs = meals(2);
    const t = carbs[carbs.length - 1]!.at + 40 * H;
    const { checks } = fast(41, { readings: [{ at: t, ketone: 0.1, glucose: 5.0 }] });
    expect(checks[0]!.liverBefore).toBeLessThan(0.1);
    expect(checks[0]!.liverAfter).toBeGreaterThan(0.3);
  });

  test("glucose says how far to trust the ketone strip", () => {
    const low = liverEvidence({ at: 0, ketone: 1, glucose: 4.0 })!;
    const none = liverEvidence({ at: 0, ketone: 1, glucose: null })!;
    const high = liverEvidence({ at: 0, ketone: 1, glucose: 7.5 })!;
    expect(low.ceiling).toBe(none.ceiling);
    expect(low.weight).toBeGreaterThan(none.weight);
    expect(none.weight).toBeGreaterThan(high.weight);
    // Right after a workout, raised ketones count for less.
    expect(liverEvidence({ at: 0, ketone: 1, glucose: 4.0 }, 1)!.weight).toBeLessThan(low.weight);
  });

  test("glucose alone only speaks when it's low", () => {
    expect(liverEvidence({ at: 0, ketone: null, glucose: 5.2 })).toBeNull();
    expect(liverEvidence({ at: 0, ketone: null, glucose: 3.5 })?.ceiling).toBeLessThan(0.3);
  });

  test("the ceiling tightens smoothly as ketones rise", () => {
    const c = (k: number) => liverEvidence({ at: 0, ketone: k, glucose: null })!.ceiling!;
    expect(c(0.4)).toBeGreaterThan(c(0.6));
    expect(c(0.6)).toBeGreaterThan(c(1.2));
    expect(c(1.2)).toBeGreaterThan(c(2.5));
  });
});

describe("fitDrain", () => {
  /** A month with a 40 h fast each week, read at 20 h and 36 h in. */
  function history(trueDrain: number) {
    const carbs: Dose[] = [];
    const times: number[] = [];
    for (let w = 0; w < 4; w++) {
      const start = T0 + w * 7 * 24 * H;
      carbs.push(...meals(5, start));
      const lastMeal = start + 4 * 24 * H + 12 * H;
      times.push(lastMeal + 20 * H, lastMeal + 36 * H);
    }
    const input = { carbs, workouts: [], fromMs: T0, toMs: T0 + 28 * 24 * H, warmupFromMs: T0, weightKg: 75 };
    const { points } = simulateGlycogen({ ...input, readings: [], drain: trueDrain });
    const readings = times.map((t) => ({ at: t, ketone: Math.round(at(points, t).ketone * 10) / 10, glucose: null }));
    return { input, readings };
  }

  test("needs a few readings", () => {
    const { input, readings } = history(1.4);
    expect(fitDrain(input, readings.slice(0, DRAIN_FIT_MIN_READINGS - 1))).toBeNull();
  });

  test("finds a liver that empties faster, and one that empties slower", () => {
    const fastLiver = history(1.4);
    expect(fitDrain(fastLiver.input, fastLiver.readings)!.drain).toBeGreaterThanOrEqual(1.2);
    const slowLiver = history(0.7);
    expect(fitDrain(slowLiver.input, slowLiver.readings)!.drain).toBeLessThanOrEqual(0.9);
  });

  test("stays at the textbook when the readings agree with it", () => {
    const { input, readings } = history(1);
    expect(fitDrain(input, readings)).toEqual({ drain: 1, used: readings.length });
  });
});

describe("muscle", () => {
  const base = { readings: [], fromMs: T0, warmupFromMs: T0, weightKg: 75 };
  const workout = { at: T0 + 2 * H, durationMin: 90, kcal: 1200, zone2Min: 0 };

  test("only a workout takes from it: a fast leaves it alone", () => {
    const { points, lastMeal } = fast(48);
    expect(points[points.length - 1]!.muscle).toBeCloseTo(at(points, lastMeal + 8 * H).muscle, 5);
  });

  test("the ledger adds up what a workout took and carbs put back", () => {
    const run = simulateGlycogen({ ...base, carbs: meals(2), workouts: [workout], toMs: T0 + 2 * 24 * H });
    expect(run.muscleBurnedG).toBeCloseTo(muscleCostG(workout), 0);
    expect(run.muscleRefilledG).toBeGreaterThan(50);
    const end = run.points[run.points.length - 1]!;
    expect(end.muscle * run.muscleCapG).toBeCloseTo(0.8 * run.muscleCapG - run.muscleBurnedG + run.muscleRefilledG, 0);
  });

  test("refills faster the emptier it is", () => {
    const refilled = (sessions: number) => {
      const workouts = Array.from({ length: sessions }, (_, i) => ({ ...workout, at: T0 + 2 * H + i * 2 * H }));
      const start = T0 + 12 * H;
      // One huge carb meal, so the rate and not the supply is the limit.
      const run = simulateGlycogen({
        ...base,
        carbs: [{ at: start, amount: 600 }],
        workouts,
        toMs: start + 6 * H,
        ledgerFromMs: start,
      });
      return run.muscleRefilledG;
    };
    expect(refilled(3)).toBeGreaterThan(refilled(1) * 1.2);
  });

  test("an easy session costs less than a hard one of the same energy", () => {
    const w = { at: 0, durationMin: 60, kcal: 600, zone2Min: null };
    expect(muscleCostG({ ...w, focus: "low" })).toBeLessThan(muscleCostG({ ...w, focus: "high" }));
    expect(muscleCostG({ ...w, focus: "anaerobic" })).toBeGreaterThan(muscleCostG({ ...w, focus: "high" }));
    expect(muscleCostG({ ...w, focus: null })).toBe(muscleCostG({ ...w, focus: "high" }));
  });
});
