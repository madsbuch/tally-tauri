/**
 * The diary, read as what's in the body: caffeine and alcohol by the hour,
 * creatine and vitamin D by the week. The models are in lib/bodyModel.ts;
 * this file gathers the doses from what was logged and asks them.
 *
 * Vitamin D also reads the document library: the newest blood test with a
 * 25(OH)D value pins the estimate to a real number.
 *
 * Every number comes out of the meal entries' own nutrients (caffeine_mg,
 * alcohol_g, creatine_g, vitamin_d_ug) — nothing extra to log. The old
 * supplement logs count too, so a history from before supplements became
 * food isn't lost.
 */
import {
  getLatestWeightKg,
  getSetting,
  listDocuments,
  listFoodEntriesForRange,
  listSupplementLogsForRange,
  todayStr,
} from "./db";
import { shiftDay } from "./daystamp";
import { SETTING_KEYS } from "./types";
import type {
  FoodEntry,
  LibraryDocument,
  Nutrients,
  SupplementLogWithSupplement,
} from "./types";
import {
  CAFFEINE_HALF_LIVES,
  CAFFEINE_SLEEP_MG,
  DAY_MS,
  DEFAULT_CAFFEINE_HALF_LIFE_H,
  DEFAULT_WEIGHT_KG,
  HOUR_MS,
  alcoholKinetics,
  caffeineKinetics,
  CREATINE_WORKING,
  creatineDaysTo,
  creatineDaysUntilBelow,
  creatineStore,
  levelAt,
  promille,
  simulate,
  VITAMIN_D,
  VITAMIN_D_ENOUGH,
  VITAMIN_D_TARGET,
  vitaminDBand,
  vitaminDBaseline,
  vitaminDContribution,
  vitaminDUgFor,
  whenBelow,
} from "./bodyModel";
import type { Dose, Point, VitaminDBand } from "./bodyModel";

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

/** A 25(OH)D result read off a lab report in the library. */
export interface VitaminDTest {
  /** Local day the test refers to. */
  day: string;
  nmol: number;
  /** The library document it came from. */
  documentId: number;
}

/** A blood test older than this says too little about now to anchor on. */
const VITAMIN_D_TEST_MAX_DAYS = 365;

/**
 * Lab names for 25(OH)D across languages and labs — "Vitamin D", "D-vitamin",
 * "25-OH-D3", "25-hydroxyvitamin D", "calcidiol" — but not 1,25(OH)₂D
 * (calcitriol), the active hormone, which says nothing about stores.
 */
const VITAMIN_D_NAME = /vitamin\s*d|d[-\s]?vitamin|25[-\s]*\(?oh\)?|25-hydroxy|calcidiol|kalcidiol/i;
const NOT_STORES = /1\s*[,.]\s*25|calcitriol|kalcitriol/i;

/**
 * A lab value as nmol/L, or null when it isn't a plain number. ng/mL (and the
 * same thing as µg/L) is converted; anything else is taken as nmol/L, which is
 * what nearly every lab outside the US reports.
 */
export function vitaminDNmol(value: string, unit: string): number | null {
  const m = /^[<>≤≥~]?\s*(\d+(?:[.,]\d+)?)\s*$/.exec(value.trim());
  if (!m) return null;
  const n = Number(m[1]!.replace(",", "."));
  if (!isFinite(n) || n <= 0) return null;
  const ng = /ng\s*\/\s*ml|[µu]g\s*\/\s*l|mcg\s*\/\s*l/i.test(unit);
  return ng ? n * VITAMIN_D.nmolPerNg : n;
}

/** The newest usable 25(OH)D result in the library, up to a year old. */
export function findVitaminDTest(docs: LibraryDocument[], today: string): VitaminDTest | null {
  const oldest = shiftDay(today, -VITAMIN_D_TEST_MAX_DAYS);
  let best: VitaminDTest | null = null;
  for (const d of docs) {
    const day = d.document_date;
    if (d.status !== "ready" || !day || day > today || day < oldest) continue;
    if (best && day <= best.day) continue;
    for (const v of d.extracted) {
      if (!VITAMIN_D_NAME.test(v.name) || NOT_STORES.test(v.name)) continue;
      const nmol = vitaminDNmol(v.value, v.unit);
      if (nmol != null) {
        best = { day, nmol, documentId: d.id };
        break;
      }
    }
  }
  return best;
}

export interface BodyProfile {
  weightKg: number;
  /** False when DEFAULT_WEIGHT_KG stands in for a weight nobody synced. */
  weightKnown: boolean;
  caffeineHalfLifeH: number;
  /** The newest vitamin D blood test in the library, if any. */
  vitaminDTest: VitaminDTest | null;
}

export async function loadProfile(): Promise<BodyProfile> {
  const [w, half, docs] = await Promise.all([
    getLatestWeightKg().catch(() => null),
    getCaffeineHalfLife().catch(() => DEFAULT_CAFFEINE_HALF_LIFE_H),
    listDocuments().catch(() => []),
  ]);
  return {
    weightKg: w ?? DEFAULT_WEIGHT_KG,
    weightKnown: w != null,
    caffeineHalfLifeH: half,
    vitaminDTest: findVitaminDTest(docs, todayStr()),
  };
}

/** Whole days from local day `a` to `b`. */
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / DAY_MS);
}

/** Noon on a local day, for the season. */
function noonOf(day: string): number {
  const [y = 0, m = 1, d = 1] = day.split("-").map(Number);
  return new Date(y, m - 1, d, 12).getTime();
}

/**
 * Days of history the stores need from today: STORE_DAYS, or enough to see
 * what was going on in the weeks before a vitamin D test.
 */
export function storeDays(profile: BodyProfile, today: string): number {
  const test = profile.vitaminDTest;
  return test ? Math.max(STORE_DAYS, daysBetween(test.day, today) + 90) : STORE_DAYS;
}

/** First day to load intake from for a snapshot of `today`. */
export function intakeStartDay(profile: BodyProfile, today: string): string {
  return shiftDay(today, -storeDays(profile, today));
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
    /** Local day it drops under CREATINE_WORKING if none is taken from today; null = already under. */
    belowWorkingOn: string | null;
    /** Days of 5 g a day to get back over CREATINE_WORKING; 0 = already over. */
    daysToWorking: number;
    /** Local day of the last creatine logged, within the history. */
    lastDay: string | null;
  };
  vitaminD: {
    /**
     * Estimated blood level, nmol/L: the seasonal baseline, plus what the
     * logged intake adds, shifted by the blood test when there is one.
     */
    level: number;
    band: VitaminDBand;
    /** Estimated level day by day, oldest first, STORE_SHOWN_DAYS long. */
    series: number[];
    /** nmol/L of that the logged intake accounts for. */
    contribution: number;
    /** The sun-and-season part on its own (with the test's shift). */
    baseline: number;
    /** Average daily µg over the last 30 days. */
    avg30: number;
    /** The blood test the estimate is pinned to, or null for the average. */
    test: VitaminDTest | null;
    /** How far the test put this person from the average, nmol/L. */
    offset: number;
    /** Estimated level `PROJECT_DAYS` from now if `avg30` keeps up. */
    projected: number;
    projectedDay: string;
    /** µg a day that keep the level over 50 / 75 nmol/L through winter. */
    ugForEnough: number;
    ugForTarget: number;
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
  const vitamin = vitaminDOf(intake, profile, day);

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
      belowWorkingOn:
        creatine.now >= CREATINE_WORKING
          ? shiftDay(day, creatineDaysUntilBelow(creatine.now))
          : null,
      daysToWorking: creatineDaysTo(creatine.now, 5, CREATINE_WORKING, profile.weightKg) ?? 0,
      lastDay,
    },
    vitaminD: vitamin,
  };
}

/** How far ahead the vitamin D projection looks: about four half-lives. */
const PROJECT_DAYS = 60;

function vitaminDOf(intake: Intake, profile: BodyProfile, day: string): BodySnapshot["vitaminD"] {
  const count = storeDays(profile, day);
  const ug = daily(intake.vitaminDByDay, day, count);
  const contrib = vitaminDContribution(ug);
  const dayAt = (i: number) => shiftDay(day, i - count + 1);

  const test = profile.vitaminDTest;
  let offset = 0;
  if (test) {
    const i = count - 1 - daysBetween(test.day, day);
    const atTest = contrib.series[i] ?? 0;
    offset = test.nmol - vitaminDBaseline(noonOf(test.day)) - atTest;
  }
  const levelOf = (base: number, c: number) => Math.max(c, base + offset + c, 5);

  const series = contrib.series
    .slice(-STORE_SHOWN_DAYS)
    .map((c, j) => levelOf(vitaminDBaseline(noonOf(dayAt(count - STORE_SHOWN_DAYS + j))), c));
  const baseNow = vitaminDBaseline(noonOf(day));
  const level = levelOf(baseNow, contrib.now);

  const avg30 = ug.slice(-30).reduce((a, b) => a + b, 0) / 30;
  const keep = Math.pow(0.5, PROJECT_DAYS / VITAMIN_D.halfLifeDays);
  const cLater = contrib.now * keep + (1 - keep) * VITAMIN_D.nmolPerUgDaily * avg30;
  const projectedDay = shiftDay(day, PROJECT_DAYS);

  return {
    level,
    band: vitaminDBand(level),
    series,
    contribution: contrib.now,
    baseline: Math.max(0, baseNow + offset),
    avg30,
    test,
    offset,
    projected: levelOf(vitaminDBaseline(noonOf(projectedDay)), cLater),
    projectedDay,
    ugForEnough: vitaminDUgFor(VITAMIN_D_ENOUGH, offset),
    ugForTarget: vitaminDUgFor(VITAMIN_D_TARGET, offset),
  };
}

/** The snapshot for `at` (default: now), loaded from the diary. */
export async function loadBodySnapshot(at = new Date()): Promise<BodySnapshot> {
  const day = todayStr(at);
  const profile = await loadProfile();
  const intake = await loadIntake(intakeStartDay(profile, day), shiftDay(day, 1));
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

export { CAFFEINE_SLEEP_MG, CREATINE_WORKING, DAY_MS, HOUR_MS, VITAMIN_D_ENOUGH, VITAMIN_D_TARGET };
