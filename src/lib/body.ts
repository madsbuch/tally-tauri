/**
 * The diary, read as what's in the body: caffeine and alcohol by the hour,
 * creatine and vitamin D by the week. The models are in lib/bodyModel.ts;
 * this file gathers the doses from what was logged and asks them.
 *
 * Every number comes out of the meal entries' own nutrients (caffeine_mg,
 * alcohol_g, creatine_g, vitamin_d_ug) — nothing extra to log. The old
 * supplement logs count too, so a history from before supplements became
 * food isn't lost.
 */
import {
  getLatestWeightKg,
  getSetting,
  listFoodEntriesForRange,
  listSupplementLogsForRange,
  todayStr,
} from "./db";
import { shiftDay } from "./daystamp";
import { SETTING_KEYS } from "./types";
import type { FoodEntry, Nutrients, SupplementLogWithSupplement } from "./types";
import {
  CAFFEINE_HALF_LIVES,
  CAFFEINE_SLEEP_MG,
  DAY_MS,
  DEFAULT_CAFFEINE_HALF_LIFE_H,
  DEFAULT_WEIGHT_KG,
  HOUR_MS,
  alcoholKinetics,
  caffeineKinetics,
  creatineDaysTo,
  creatineStore,
  levelAt,
  promille,
  simulate,
  vitaminDContribution,
  vitaminDSteady,
  whenBelow,
} from "./bodyModel";
import type { Dose, Point } from "./bodyModel";

/** Days of history the weekly stores are built from (vitamin D needs ~2 months). */
const STORE_DAYS = 120;
/** Days of history shown for a store. */
export const STORE_SHOWN_DAYS = 60;
/** How far back a dose can still matter for the hourly ones. */
const HOURLY_LOOKBACK_MS = 48 * HOUR_MS;

export interface Intake {
  caffeine: Dose[];
  alcohol: Dose[];
  /** Grams of creatine per local day. */
  creatineByDay: Map<string, number>;
  /** µg of vitamin D per local day. */
  vitaminDByDay: Map<string, number>;
}

/**
 * Creatine counts only when taken as a supplement. Meat carries some too —
 * that's the diet baseline the store sits on top of, and counting a steak
 * would fill a store that isn't being filled.
 */
function isCreatineSupplement(e: FoodEntry): boolean {
  return e.icon === "supplement" || /creatin|kreatin/i.test(e.title);
}

function add(map: Map<string, number>, day: string, v: number | undefined): void {
  if (typeof v === "number" && isFinite(v) && v > 0) map.set(day, (map.get(day) ?? 0) + v);
}

function dose(list: Dose[], iso: string, v: number | undefined): void {
  if (typeof v === "number" && isFinite(v) && v > 0) list.push({ at: Date.parse(iso), amount: v });
}

function intakeFrom(
  entries: FoodEntry[],
  supplementLogs: SupplementLogWithSupplement[],
): Intake {
  const out: Intake = {
    caffeine: [],
    alcohol: [],
    creatineByDay: new Map(),
    vitaminDByDay: new Map(),
  };
  const take = (iso: string, day: string, n: Nutrients, creatine: boolean) => {
    dose(out.caffeine, iso, n.caffeine_mg);
    dose(out.alcohol, iso, n.alcohol_g);
    if (creatine) add(out.creatineByDay, day, n.creatine_g);
    add(out.vitaminDByDay, day, n.vitamin_d_ug);
  };
  for (const e of entries) {
    take(e.eaten_at, e.day ?? todayStr(new Date(e.eaten_at)), e.nutrients, isCreatineSupplement(e));
  }
  for (const l of supplementLogs) {
    const n: Nutrients = {};
    for (const [k, v] of Object.entries(l.nutrients)) {
      if (typeof v === "number") n[k as keyof Nutrients] = v * l.amount;
    }
    take(l.taken_at, l.day ?? todayStr(new Date(l.taken_at)), n, true);
  }
  return out;
}

/** Everything logged from `startDay` through `endDay`, as doses. */
export async function loadIntake(startDay: string, endDay: string): Promise<Intake> {
  const [entries, logs] = await Promise.all([
    listFoodEntriesForRange(startDay, endDay),
    listSupplementLogsForRange(startDay, endDay).catch(() => []),
  ]);
  return intakeFrom(entries, logs);
}

/** The personal caffeine half-life, falling back to the textbook 5 h. */
export async function getCaffeineHalfLife(): Promise<number> {
  const raw = Number(await getSetting(SETTING_KEYS.caffeineHalfLife));
  return (CAFFEINE_HALF_LIVES as readonly number[]).includes(raw)
    ? raw
    : DEFAULT_CAFFEINE_HALF_LIFE_H;
}

export interface BodyProfile {
  weightKg: number;
  /** False when DEFAULT_WEIGHT_KG stands in for a weight nobody synced. */
  weightKnown: boolean;
  caffeineHalfLifeH: number;
}

export async function loadProfile(): Promise<BodyProfile> {
  const [w, half] = await Promise.all([
    getLatestWeightKg().catch(() => null),
    getCaffeineHalfLife().catch(() => DEFAULT_CAFFEINE_HALF_LIFE_H),
  ]);
  return { weightKg: w ?? DEFAULT_WEIGHT_KG, weightKnown: w != null, caffeineHalfLifeH: half };
}

/** Day-by-day values, oldest first, for the `count` days ending on `endDay`. */
function daily(map: Map<string, number>, endDay: string, count: number): number[] {
  return Array.from({ length: count }, (_, i) => map.get(shiftDay(endDay, i - count + 1)) ?? 0);
}

const recent = (doses: Dose[], atMs: number) =>
  doses.filter((d) => d.at <= atMs && d.at > atMs - HOURLY_LOOKBACK_MS);

export interface HourlyLevel {
  /** Amount in the body at the snapshot moment (mg caffeine, g alcohol). */
  now: number;
  /** The curve from `from` to `to`, every 5 minutes. */
  series: Point[];
  /** Doses inside the curve's window. */
  doses: Dose[];
  from: number;
  to: number;
}

export interface BodySnapshot {
  at: number;
  profile: BodyProfile;
  caffeine: HourlyLevel & {
    /** When it's under CAFFEINE_SLEEP_MG for good; `at` when it already is. */
    belowSleepAt: number | null;
  };
  alcohol: HourlyLevel & {
    promille: number;
    /** When it's all cleared; `at` when there's none. */
    goneAt: number | null;
  };
  creatine: {
    /** 0..1 of a full store. */
    fraction: number;
    /** Day by day, oldest first, STORE_SHOWN_DAYS long. */
    series: number[];
    /** Average daily grams over the last 7 days. */
    avg7: number;
    /** Days to 90% at that pace; 0 = already there; null = never at this pace. */
    daysToFull: number | null;
    /** Local day of the last creatine logged, within the history. */
    lastDay: string | null;
  };
  vitaminD: {
    /** nmol/L the logged intake accounts for. */
    contribution: number;
    series: number[];
    /** Average daily µg over the last 30 days. */
    avg30: number;
    /** Where the contribution settles at that average. */
    steady: number;
  };
}

/**
 * Everything at one moment. The hourly curves run from `backH` before it to
 * `aheadH` after, so the page can draw where it's been and where it's going.
 */
export function snapshotOf(
  intake: Intake,
  profile: BodyProfile,
  atMs: number,
  backH = 8,
  aheadH = 16,
): BodySnapshot {
  const from = atMs - backH * HOUR_MS;
  const to = atMs + aheadH * HOUR_MS;
  const inWindow = (doses: Dose[]) => doses.filter((d) => d.at >= from && d.at <= atMs);

  const ck = caffeineKinetics(profile.caffeineHalfLifeH);
  const cDoses = recent(intake.caffeine, atMs);
  const ak = alcoholKinetics(profile.weightKg);
  const aDoses = recent(intake.alcohol, atMs);
  const alcoholNow = levelAt(aDoses, ak, atMs);

  const day = todayStr(new Date(atMs));
  const creatineDays = daily(intake.creatineByDay, day, STORE_DAYS);
  const creatine = creatineStore(creatineDays, profile.weightKg);
  const avg7 = creatineDays.slice(-7).reduce((a, b) => a + b, 0) / 7;
  let lastDay: string | null = null;
  for (let i = creatineDays.length - 1; i >= 0; i--) {
    if ((creatineDays[i] ?? 0) > 0) {
      lastDay = shiftDay(day, i - creatineDays.length + 1);
      break;
    }
  }
  const vitDDays = daily(intake.vitaminDByDay, day, STORE_DAYS);
  const vitD = vitaminDContribution(vitDDays);
  const avg30 = vitDDays.slice(-30).reduce((a, b) => a + b, 0) / 30;

  return {
    at: atMs,
    profile,
    caffeine: {
      now: levelAt(cDoses, ck, atMs),
      series: simulate(cDoses, ck, from, to),
      doses: inWindow(cDoses),
      from,
      to,
      belowSleepAt: whenBelow(cDoses, ck, CAFFEINE_SLEEP_MG, atMs),
    },
    alcohol: {
      now: alcoholNow,
      series: simulate(aDoses, ak, from, to),
      doses: inWindow(aDoses),
      from,
      to,
      promille: promille(alcoholNow, profile.weightKg),
      // "Gone" is under a tenth of a gram, not exactly zero.
      goneAt: whenBelow(aDoses, ak, 0.1, atMs),
    },
    creatine: {
      fraction: creatine.now,
      series: creatine.series.slice(-STORE_SHOWN_DAYS),
      avg7,
      daysToFull: creatineDaysTo(creatine.now, avg7, 0.9, profile.weightKg),
      lastDay,
    },
    vitaminD: {
      contribution: vitD.now,
      series: vitD.series.slice(-STORE_SHOWN_DAYS),
      avg30,
      steady: vitaminDSteady(avg30),
    },
  };
}

/** The snapshot for `at` (default: now), loaded from the diary. */
export async function loadBodySnapshot(at = new Date()): Promise<BodySnapshot> {
  const day = todayStr(at);
  const [intake, profile] = await Promise.all([
    loadIntake(shiftDay(day, -STORE_DAYS), shiftDay(day, 1)),
    loadProfile(),
  ]);
  return snapshotOf(intake, profile, at.getTime());
}

/** Caffeine and alcohol in the body at each of `moments` (epoch ms). */
export function levelsAt(
  intake: Intake,
  profile: BodyProfile,
  moments: number[],
): { caffeineMg: number; alcoholG: number }[] {
  const ck = caffeineKinetics(profile.caffeineHalfLifeH);
  const ak = alcoholKinetics(profile.weightKg);
  return moments.map((t) => ({
    caffeineMg: levelAt(recent(intake.caffeine, t), ck, t),
    alcoholG: levelAt(recent(intake.alcohol, t), ak, t),
  }));
}

/** Local "YYYY-MM-DD HH:MM" for a moment, as the user would read it. */
export function localStamp(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${todayStr(d)} ${hh}:${mm}`;
}

/**
 * A moment the coach named: "YYYY-MM-DD HH:MM" or "HH:MM" (today) in local
 * time, or a full ISO timestamp. Null when it can't be read.
 */
export function parseLocalMoment(raw: string, now = new Date()): number | null {
  const t = raw.trim();
  const full = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})$/.exec(t);
  if (full) {
    const [, y, m, d, h, min] = full.map(Number) as number[];
    return new Date(y!, m! - 1, d!, h!, min!).getTime();
  }
  const hm = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (hm) {
    const d = new Date(now);
    d.setHours(Number(hm[1]), Number(hm[2]), 0, 0);
    return d.getTime();
  }
  const iso = Date.parse(t);
  return isNaN(iso) ? null : iso;
}

export { CAFFEINE_SLEEP_MG, DAY_MS, HOUR_MS };
