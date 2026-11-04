import { describe, expect, test } from "bun:test";
import {
  HOUR_MS,
  alcoholKinetics,
  caffeineKinetics,
  creatineDaysTo,
  creatineStore,
  levelAt,
  vitaminDContribution,
  whenBelow,
} from "../src/lib/bodyModel";

const T0 = Date.UTC(2026, 10, 4, 8);

describe("caffeine", () => {
  const k = caffeineKinetics(5);
  const doses = [{ at: T0, amount: 200 }];

  test("absorbs over the first hour, then halves every half-life", () => {
    expect(levelAt(doses, k, T0)).toBe(0);
    const peakish = levelAt(doses, k, T0 + HOUR_MS);
    expect(peakish).toBeGreaterThan(150);
    expect(peakish).toBeLessThan(200);
    const at6 = levelAt(doses, k, T0 + 6 * HOUR_MS);
    const at11 = levelAt(doses, k, T0 + 11 * HOUR_MS);
    expect(at11 / at6).toBeCloseTo(0.5, 2);
  });

  test("doses add up", () => {
    const two = [...doses, { at: T0 + 6 * HOUR_MS, amount: 100 }];
    expect(levelAt(two, k, T0 + 14 * HOUR_MS)).toBeGreaterThan(levelAt(doses, k, T0 + 14 * HOUR_MS) + 30);
  });

  test("finds when it drops under the sleep line, and ignores the climb", () => {
    const below = whenBelow(doses, k, 50, T0);
    expect(below).not.toBeNull();
    // 200 mg → 50 mg is two half-lives, plus the absorption delay.
    const hours = (below! - T0) / HOUR_MS;
    expect(hours).toBeGreaterThan(10);
    expect(hours).toBeLessThan(11.5);
    expect(whenBelow([], k, 50, T0)).toBe(T0);
  });
});

describe("alcohol", () => {
  test("clears at a steady rate, so twice as much takes about twice as long", () => {
    const k = alcoholKinetics(75);
    const one = whenBelow([{ at: T0, amount: 12 }], k, 0.1, T0)!;
    const four = whenBelow([{ at: T0, amount: 48 }], k, 0.1, T0)!;
    expect((one - T0) / HOUR_MS).toBeGreaterThan(1.2);
    expect((one - T0) / HOUR_MS).toBeLessThan(2.5);
    const ratio = (four - T0) / (one - T0);
    expect(ratio).toBeGreaterThan(3);
    expect(ratio).toBeLessThan(4.5);
  });
});

describe("creatine store", () => {
  const days = (n: number, g: number) => Array.from({ length: n }, () => g);

  test("3 g a day fills it in about four weeks", () => {
    const s = creatineStore(days(28, 3)).series;
    expect(s[6]!).toBeLessThan(0.5);
    expect(s[27]!).toBeGreaterThan(0.8);
  });

  test("loading fills it in under a week, and stopping drains it over weeks", () => {
    const loaded = creatineStore(days(6, 20)).now;
    expect(loaded).toBeGreaterThan(0.9);
    const drained = creatineStore([...days(6, 20), ...days(10, 0)]).now;
    expect(drained).toBeCloseTo(loaded / 2, 1);
    expect(creatineStore([...days(6, 20), ...days(42, 0)]).now).toBeLessThan(0.1);
  });

  test("days to full", () => {
    expect(creatineDaysTo(0.95, 3)).toBe(0);
    expect(creatineDaysTo(0, 0)).toBeNull();
    const d = creatineDaysTo(0, 5)!;
    // Faster than 3 g/day's four weeks, slower than loading.
    expect(d).toBeGreaterThan(7);
    expect(d).toBeLessThan(28);
  });
});

describe("vitamin D", () => {
  test("settles near 1 nmol/L per daily µg, half gone in ~15 days", () => {
    const on = vitaminDContribution(Array.from({ length: 120 }, () => 25)).now;
    expect(on).toBeGreaterThan(23);
    expect(on).toBeLessThanOrEqual(25);
    const off = vitaminDContribution([...Array.from({ length: 120 }, () => 25), ...Array.from({ length: 15 }, () => 0)]).now;
    expect(off / on).toBeCloseTo(0.5, 1);
  });
});
