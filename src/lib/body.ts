/**
 * The diary, read as what's in the body: caffeine and alcohol by the hour,
 * creatine and vitamin D by the week. The models are in lib/bodyModel.ts;
 * this file gathers the doses from what was logged and asks them.
 *
 * Vitamin D, the omega-3 index and ferritin also read the document library:
 * the newest blood test with that value pins the estimate to a real number.
 * The rest of the stores (lib/storeModels.ts) read workouts, synced sleep and
 * the blood meter's glucose and ketone readings too.
 *
 * Every number comes out of the meal entries' own nutrients (caffeine_mg,
 * alcohol_g, creatine_g, vitamin_d_ug) — nothing extra to log. The old
 * supplement logs count too, so a history from before supplements became
 * food isn't lost.
 */
import {
  getLatestWeightKg,
  getSetting,
  listAllFasts,
  listDocuments,
  listBloodReadingsForRange,
  listFoodEntriesForRange,
  listSleepForRange,
  listSupplementLogsForRange,
  listWorkoutsForRange,
  todayStr,
} from "./db";
import { shiftDay } from "./daystamp";
import { partnerOf } from "./readings";
import { garminDetailsForWorkouts, latestGarminLoadBalance, listGarminDaysForRange } from "./garminDb";
import type { GarminLoadBalance } from "./schemas";
import type { GarminWorkoutDetail } from "./garminDb";
import { SETTING_KEYS } from "./types";
import type {
  Fast,
  FoodEntry,
  BloodReading,
  LibraryDocument,
  NutrientKey,
  Nutrients,
  SleepSession,
  SupplementLogWithSupplement,
  Workout,
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
import {
  BETA_ALANINE,
  FERRITIN_BANDS,
  LIVER_KETOSIS,
  MUSCLE_BANDS,
  OMEGA3_BANDS,
  OMEGA3_TARGET,
  RESERVES,
  RESERVE_BANDS,
  SLEEP,
  SLEEP_BANDS,
  TRAINING,
  TRAINING_BANDS,
  bandOf,
  betaAlanineStore,
  ferritinSeries,
  ferritinSteady,
  fitDrain,
  ironFor,
  ketoneSeries,
  liverBelowAt,
  liverSeries,
  focusOf,
  focusTotals,
  loadOf,
  meanLogged,
  muscleCostG,
  omega3GramsFor,
  omega3Index,
  omega3Steady,
  reserveSeries,
  simulateGlycogen,
  sleepDebt,
  trainingLoad,
} from "./storeModels";
import type {
  Band,
  DailyIntake,
  DrainFit,
  FuelReading,
  LoadFocus,
  MeterReading,
  ReadingCheck,
  ReserveDef,
  WorkoutBurn,
} from "./storeModels";

/** Days of history the weekly stores are built from (vitamin D needs ~2 months). */
const STORE_DAYS = 120;
/** Days of history shown for a store. */
export const STORE_SHOWN_DAYS = 60;
/** How far back a dose can still matter for the hourly ones. */
const HOURLY_LOOKBACK_MS = 48 * HOUR_MS;

/** Nutrients summed per local day for the slow stores. */
const DAILY_KEYS = [
  "epa_dha_g",
  "iron_mg",
  "beta_alanine_g",
  ...RESERVES.map((r) => r.key),
] as const satisfies readonly NutrientKey[];
type DailyKey = (typeof DAILY_KEYS)[number];

export interface Intake {
  caffeine: Dose[];
  alcohol: Dose[];
  /** Net carbs (g) per entry, for glycogen. */
  carbs: Dose[];
  /** Grams of creatine per local day. */
  creatineByDay: Map<string, number>;
  /** µg of vitamin D per local day. */
  vitaminDByDay: Map<string, number>;
  /** Other per-day totals (EPA + DHA, iron, beta-alanine, the reserves). */
  byDay: Record<DailyKey, Map<string, number>>;
  /** Local days with anything logged at all. */
  loggedDays: Set<string>;
  workouts: (WorkoutBurn & { day: string })[];
  /** Hours slept per night, keyed by the morning's local day. */
  sleepByNight: Map<string, number>;
  /** Meter readings, a ketone and a glucose strip taken together as one. */
  readings: FuelReading[];
  /** Local days inside a recorded fast: nothing logged there is nothing eaten. */
  fastedDays: Set<string>;
  /** Garmin's own training read of recent days, newest first. */
  garminDays: GarminTrainingDay[];
  /** Garmin's own load focus, newest, with the day it's for. */
  garminBalance: { day: string; balance: GarminLoadBalance } | null;
}

/** What Garmin itself says about a day's training (direct sync only). */
export interface GarminTrainingDay {
  day: string;
  /** "PRODUCTIVE", "MAINTAINING", … */
  status: string | null;
  /** Garmin's weekly acute and chronic load. */
  acute: number | null;
  chronic: number | null;
  readiness: number | null;
  readinessLevel: string | null;
  hrvStatus: string | null;
}

/**
 * Marine omega-3 for an entry logged before epa_dha_g existed: fish and fish
 * oil's omega-3 is mostly EPA + DHA; anything else's is assumed to be plant
 * ALA, which the body barely converts.
 */
const MARINE =
  /fish|salmon|laks|mackerel|makrel|sardin|herring|sild|tuna|tun\b|trout|ørred|anchov|ansjos|krill|cod liver|levertran|tran\b|algae|alge|omega|seafood|rejer|shrimp|prawn|oyster|østers|mussel|musling/i;
const MARINE_SHARE = 0.85;

function epaDhaOf(e: { title: string }, n: Nutrients): number | undefined {
  if (n.epa_dha_g != null) return n.epa_dha_g;
  return n.omega3_g != null && MARINE.test(e.title) ? n.omega3_g * MARINE_SHARE : undefined;
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
  workouts: Workout[] = [],
  sleep: SleepSession[] = [],
  readings: BloodReading[] = [],
  garmin: Map<number, { load: number | null; focus: LoadFocus | null }> = new Map(),
  garminDays: GarminTrainingDay[] = [],
  garminBalance: Intake["garminBalance"] = null,
  fastedDays: Set<string> = new Set(),
): Intake {
  const byDay = Object.fromEntries(DAILY_KEYS.map((k) => [k, new Map<string, number>()])) as Record<
    DailyKey,
    Map<string, number>
  >;
  const out: Intake = {
    caffeine: [],
    alcohol: [],
    carbs: [],
    creatineByDay: new Map(),
    vitaminDByDay: new Map(),
    byDay,
    loggedDays: new Set(),
    workouts: [],
    sleepByNight: new Map(),
    readings: fuelReadings(readings),
    fastedDays,
    garminDays,
    garminBalance,
  };
  const take = (iso: string, day: string, title: string, n: Nutrients, creatine: boolean) => {
    out.loggedDays.add(day);
    dose(out.caffeine, iso, n.caffeine_mg);
    dose(out.alcohol, iso, n.alcohol_g);
    if (n.carbs_g != null) dose(out.carbs, iso, Math.max(0, n.carbs_g - (n.fiber_g ?? 0)));
    if (creatine) add(out.creatineByDay, day, n.creatine_g);
    add(out.vitaminDByDay, day, n.vitamin_d_ug);
    for (const k of DAILY_KEYS) {
      add(byDay[k], day, k === "epa_dha_g" ? epaDhaOf({ title }, n) : n[k]);
    }
  };
  for (const e of entries) {
    take(e.eaten_at, e.day ?? todayStr(new Date(e.eaten_at)), e.title, e.nutrients, isCreatineSupplement(e));
  }
  for (const l of supplementLogs) {
    const n: Nutrients = {};
    for (const [k, v] of Object.entries(l.nutrients)) {
      if (typeof v === "number") n[k as keyof Nutrients] = v * l.amount;
    }
    take(l.taken_at, l.day ?? todayStr(new Date(l.taken_at)), l.name, n, true);
  }
  for (const w of workouts) {
    out.workouts.push({
      at: Date.parse(w.performed_at),
      durationMin: w.duration_min,
      kcal: w.calories_burned,
      zone2Min: w.zone2_min,
      garminLoad: garmin.get(w.id)?.load ?? null,
      focus: garmin.get(w.id)?.focus ?? null,
      day: w.day ?? todayStr(new Date(w.performed_at)),
    });
  }
  for (const s of sleep) {
    const night = s.day ?? todayStr(new Date(s.ended_at));
    const h = Math.max(0, s.duration_min - (s.awake_min ?? 0)) / 60;
    out.sleepByNight.set(night, (out.sleepByNight.get(night) ?? 0) + h);
  }
  return out;
}

/**
 * Readings as sittings at the meter: each ketone strip with the glucose strip
 * taken alongside it (lib/readings.ts decides what "alongside" is), and the
 * glucose strips that had no ketone partner on their own. Oldest first.
 */
export function fuelReadings(readings: BloodReading[]): FuelReading[] {
  const out: FuelReading[] = [];
  const paired = new Set<number>();
  for (const r of readings) {
    if (r.kind !== "ketone") continue;
    const partner = partnerOf(r, readings);
    if (partner) paired.add(partner.id);
    out.push({ at: Date.parse(r.measured_at), ketone: r.value, glucose: partner?.value ?? null });
  }
  for (const r of readings) {
    if (r.kind === "glucose" && !paired.has(r.id)) {
      out.push({ at: Date.parse(r.measured_at), ketone: null, glucose: r.value });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/** The local days from `startDay` through `endDay` that fall inside a fast. */
function fastedDaysOf(fasts: Fast[], startDay: string, endDay: string): Set<string> {
  const out = new Set<string>();
  for (const f of fasts) {
    const first = f.start_day ?? todayStr(new Date(f.started_at));
    const last = f.end_day ?? (f.ended_at ? todayStr(new Date(f.ended_at)) : endDay);
    for (let d = first < startDay ? startDay : first; d <= last && d <= endDay; d = shiftDay(d, 1)) out.add(d);
  }
  return out;
}

/** Everything logged from `startDay` through `endDay`, as doses. */
export async function loadIntake(startDay: string, endDay: string): Promise<Intake> {
  const [entries, logs, workouts, sleep, readings, fasts] = await Promise.all([
    listFoodEntriesForRange(startDay, endDay),
    listSupplementLogsForRange(startDay, endDay).catch(() => []),
    listWorkoutsForRange(startDay, endDay).catch(() => []),
    listSleepForRange(startDay, endDay).catch(() => []),
    // The whole range, not just the last days: old readings are what the
    // personal drain rate is fitted from.
    listBloodReadingsForRange(startDay, endDay).catch(() => []),
    listAllFasts().catch(() => []),
  ]);
  const [details, days, balance] = await Promise.all([
    garminDetailsForWorkouts(workouts.map((w) => w.id)).catch(
      () => new Map<number, GarminWorkoutDetail>(),
    ),
    listGarminDaysForRange(shiftDay(endDay, -GARMIN_DAYS_BACK), endDay).catch(() => []),
    latestGarminLoadBalance(shiftDay(endDay, -GARMIN_DAYS_BACK), endDay).catch(() => null),
  ]);
  const garmin = new Map<number, { load: number | null; focus: LoadFocus | null }>();
  for (const [id, d] of details) {
    garmin.set(id, {
      load: d.trainingLoad != null && d.trainingLoad >= 0 ? d.trainingLoad : null,
      focus: focusOf(d),
    });
  }
  const garminDays: GarminTrainingDay[] = days.map((d) => ({
    day: d.day,
    status: d.trainingStatus,
    acute: d.acuteLoad,
    chronic: d.chronicLoad,
    readiness: d.readinessScore,
    readinessLevel: d.readinessLevel,
    hrvStatus: d.hrvStatus,
  }));
  return intakeFrom(
    entries,
    logs,
    workouts,
    sleep,
    readings,
    garmin,
    garminDays,
    balance,
    fastedDaysOf(fasts, startDay, endDay),
  );
}

/** How far back Garmin's own training read is looked for. */
const GARMIN_DAYS_BACK = 14;
/** Garmin's read is shown as current up to this many days old. */
const GARMIN_FRESH_DAYS = 2;

/** The personal caffeine half-life, falling back to the textbook 5 h. */
export async function getCaffeineHalfLife(): Promise<number> {
  const raw = Number(await getSetting(SETTING_KEYS.caffeineHalfLife));
  return (CAFFEINE_HALF_LIVES as readonly number[]).includes(raw)
    ? raw
    : DEFAULT_CAFFEINE_HALF_LIFE_H;
}

/** A lab result read off a report in the library, in the unit the card uses. */
export interface LabTest {
  /** Local day the test refers to. */
  day: string;
  value: number;
  /** The library document it came from. */
  documentId: number;
}

/** A blood test older than this says too little about now to anchor on. */
const LAB_TEST_MAX_DAYS = 365;

interface LabMatcher {
  name: RegExp;
  /** Names that match `name` but are something else. */
  not?: RegExp;
  /** The value in the card's unit, or null when it can't be read as one. */
  convert: (n: number, unit: string) => number | null;
}

/** A lab value as a plain number ("62", "<20", "4,8 %"), or null. */
export function labNumber(value: string): number | null {
  const m = /^[<>≤≥~]?\s*(\d+(?:[.,]\d+)?)\s*%?$/.exec(value.trim());
  if (!m) return null;
  const n = Number(m[1]!.replace(",", "."));
  return isFinite(n) && n > 0 ? n : null;
}

const LABS = {
  /**
   * 25(OH)D across languages and labs — "Vitamin D", "D-vitamin", "25-OH-D3",
   * "25-hydroxyvitamin D", "calcidiol" — but not 1,25(OH)₂D (calcitriol), the
   * active hormone, which says nothing about stores. ng/mL (= µg/L) is
   * converted; anything else is taken as nmol/L, what most labs report.
   */
  vitaminD: {
    name: /vitamin\s*d|d[-\s]?vitamin|25[-\s]*\(?oh\)?|25-hydroxy|calcidiol|kalcidiol/i,
    not: /1\s*[,.]\s*25|calcitriol|kalcitriol/i,
    convert: (n, unit) =>
      /ng\s*\/\s*ml|[µu]g\s*\/\s*l|mcg\s*\/\s*l/i.test(unit) ? n * VITAMIN_D.nmolPerNg : n,
  },
  /** Omega-3 index, %. */
  omega3: {
    name: /omega[-\s]?3[-\s]?ind|ω-?3[-\s]?ind|eicosapentaen.*docosahexaen|epa\s*\+\s*dha/i,
    convert: (n) => (n > 0 && n < 30 ? n : null),
  },
  /** Ferritin, µg/L (= ng/mL); pmol/L converted. */
  ferritin: {
    name: /ferritin/i,
    convert: (n, unit) => (/pmol/i.test(unit) ? n * 0.445 : n),
  },
} satisfies Record<string, LabMatcher>;
export type LabKind = keyof typeof LABS;

/** The newest usable result of one kind in the library, up to a year old. */
export function findLabTest(docs: LibraryDocument[], today: string, kind: LabKind): LabTest | null {
  const m: LabMatcher = LABS[kind];
  const oldest = shiftDay(today, -LAB_TEST_MAX_DAYS);
  let best: LabTest | null = null;
  for (const d of docs) {
    const day = d.document_date;
    if (d.status !== "ready" || !day || day > today || day < oldest) continue;
    if (best && day <= best.day) continue;
    for (const v of d.extracted) {
      if (!m.name.test(v.name) || m.not?.test(v.name)) continue;
      const n = labNumber(v.value);
      const value = n == null ? null : m.convert(n, v.unit);
      if (value != null) {
        best = { day, value, documentId: d.id };
        break;
      }
    }
  }
  return best;
}

/** Hours of sleep a night to count debt against. */
export async function getSleepNeed(): Promise<number> {
  const raw = Number(await getSetting(SETTING_KEYS.sleepNeed));
  return (SLEEP.needs as readonly number[]).includes(raw) ? raw : SLEEP.defaultNeedH;
}

export interface BodyProfile {
  weightKg: number;
  /** False when DEFAULT_WEIGHT_KG stands in for a weight nobody synced. */
  weightKnown: boolean;
  caffeineHalfLifeH: number;
  sleepNeedH: number;
  /** The newest blood test of each kind in the library, if any. */
  labs: Record<LabKind, LabTest | null>;
}

export async function loadProfile(): Promise<BodyProfile> {
  const [w, half, need, docs] = await Promise.all([
    getLatestWeightKg().catch(() => null),
    getCaffeineHalfLife().catch(() => DEFAULT_CAFFEINE_HALF_LIFE_H),
    getSleepNeed().catch(() => SLEEP.defaultNeedH),
    listDocuments().catch(() => []),
  ]);
  const today = todayStr();
  return {
    weightKg: w ?? DEFAULT_WEIGHT_KG,
    weightKnown: w != null,
    caffeineHalfLifeH: half,
    sleepNeedH: need,
    labs: {
      vitaminD: findLabTest(docs, today, "vitaminD"),
      omega3: findLabTest(docs, today, "omega3"),
      ferritin: findLabTest(docs, today, "ferritin"),
    },
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
  let days = STORE_DAYS;
  for (const t of Object.values(profile.labs)) {
    if (t) days = Math.max(days, daysBetween(t.day, today) + 90);
  }
  return days;
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

/** The last four weeks' load by kind (see focusOf in lib/storeModels.ts). */
export interface TrainingFocus {
  /** Garmin's own split and personal targets, or the one worked out here. */
  from: "garmin" | "model";
  low: number;
  high: number;
  anaerobic: number;
  /** Load that couldn't be placed (workouts without Garmin's numbers). */
  unplaced: number;
  targets: Record<LoadFocus, { min: number; max: number } | null>;
  /** Garmin's verdict, e.g. "AEROBIC_HIGH_SHORTAGE". */
  feedback: string | null;
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
    test: LabTest | null;
    /** How far the test put this person from the average, nmol/L. */
    offset: number;
    /** Estimated level `PROJECT_DAYS` from now if `avg30` keeps up. */
    projected: number;
    projectedDay: string;
    /** µg a day that keep the level over 50 / 75 nmol/L through winter. */
    ugForEnough: number;
    ugForTarget: number;
  };
  omega3: {
    /** Estimated omega-3 index, %. */
    index: number;
    band: Band;
    series: number[];
    /** Average daily g of EPA + DHA over the last 30 logged days. */
    avg30: number;
    test: LabTest | null;
    offset: number;
    /** Where the index settles at `avg30`. */
    settles: number;
    /** g a day of EPA + DHA that settle it at the 8% target. */
    gramsForTarget: number;
  };
  ferritin: {
    /** Estimated ferritin, µg/L. */
    level: number;
    band: Band;
    series: number[];
    /** Average daily mg of iron over the last 30 logged days. */
    avg30: number;
    test: LabTest | null;
    /** Where ferritin settles at `avg30`. */
    settles: number;
    /** mg a day that settle it at 50 µg/L. */
    ironForGood: number;
  };
  betaAlanine: {
    /** 0..1 of the most carnosine can rise. */
    fraction: number;
    series: number[];
    avg7: number;
    lastDay: string | null;
  };
  reserves: {
    def: ReserveDef;
    /** 0..RESERVE_CAP of full. */
    fraction: number;
    band: Band;
    series: number[];
    /** Average daily amount over the last 30 logged days. */
    avg30: number;
  }[];
  glycogen: {
    /** 0..1 of a full liver / muscle store. */
    liver: number;
    muscle: number;
    /** What's in the muscle and what a full store holds, g. */
    muscleG: number;
    muscleCapG: number;
    muscleBand: Band;
    /** Muscle, 0..1, over the days in `muscleSinceMs`..now, every 15 minutes. */
    muscleSeries: number[];
    /** What workouts took out of muscle and carbs put back since `muscleSinceMs`, g. */
    muscleBurnedG: number;
    muscleRefilledG: number;
    muscleSinceMs: number;
    /** Workouts in that stretch, with the grams each took. */
    muscleWorkouts: { at: number; grams: number }[];
    /** Liver %, curve from `from` to `to` with the carbs eaten in it as doses. */
    curve: HourlyLevel;
    /** When the liver drops under LIVER_KETOSIS with no more carbs; `at` when it is. */
    ketosisAt: number | null;
    /** Blood ketones the model expects right now, mmol/L. */
    ketone: number;
    /** That expectation over the same window as `curve`. */
    ketoneCurve: Point[];
    /** The newest ketone reading in the last two days. */
    lastKetone: MeterReading | null;
    /** Readings inside the curve's window, with what the model expected of each. */
    checks: ReadingCheck[];
    /**
     * How fast this liver empties against the textbook, fitted to past ketone
     * readings; null until there are enough of them to say.
     */
    fit: DrainFit | null;
    /** Any carbs or workouts logged in the last three days. */
    hasData: boolean;
  };
  training: {
    /** Daily averages (× TRAINING.weekly for Garmin's weekly numbers). */
    fitness: number;
    fatigue: number;
    /**
     * acute ÷ chronic: Garmin's own when it's fresh, else the model's; null
     * when there's too little history.
     */
    ratio: number | null;
    /** Where `ratio` came from. */
    ratioFrom: "garmin" | "model";
    band: Band | null;
    fitnessSeries: number[];
    fatigueSeries: number[];
    /** Workouts in the last 7 days. */
    sessions7: number;
    /** Of the last 28 days' workouts: how many counted by Garmin's load. */
    garminCounted: number;
    workouts28: number;
    /** Garmin's newest read of its own, when recent. */
    garmin: GarminTrainingDay | null;
    focus: TrainingFocus;
  };
  sleep: {
    /** Hours owed. */
    debtH: number;
    band: Band;
    /** Debt after each of the last SLEEP_SHOWN_NIGHTS nights. */
    series: number[];
    /** Average hours over the nights synced in the last 7. */
    avg7H: number | null;
    needH: number;
    /** Nights with sleep synced in the last 14. */
    nights14: number;
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
    omega3: omega3Of(intake, profile, day),
    ferritin: ferritinOf(intake, profile, day),
    betaAlanine: betaAlanineOf(intake, day),
    reserves: RESERVES.map((def) => {
      const days = loggedDaily(intake, intake.byDay[def.key], day, STORE_DAYS);
      const series = reserveSeries(def, days);
      const fraction = series[series.length - 1] ?? 0;
      return {
        def,
        fraction,
        band: bandOf(RESERVE_BANDS, fraction),
        series: series.slice(-STORE_SHOWN_DAYS),
        avg30: meanLogged(days.slice(-30)),
      };
    }),
    glycogen: glycogenOf(intake, profile, atMs),
    training: trainingOf(intake, day, atMs),
    sleep: sleepOf(intake, profile, day),
  };
}

/** Nights of sleep debt shown. */
export const SLEEP_SHOWN_NIGHTS = 30;

/** Per-day amounts, with days that have nothing logged at all as null. */
function loggedDaily(intake: Intake, map: Map<string, number>, endDay: string, count: number): DailyIntake {
  return Array.from({ length: count }, (_, i) => {
    const d = shiftDay(endDay, i - count + 1);
    return intake.loggedDays.has(d) ? (map.get(d) ?? 0) : null;
  });
}

function omega3Of(intake: Intake, profile: BodyProfile, day: string): BodySnapshot["omega3"] {
  const count = storeDays(profile, day);
  const days = loggedDaily(intake, intake.byDay.epa_dha_g, day, count);
  const model = omega3Index(days);
  const test = profile.labs.omega3;
  const offset = test ? test.value - (model[count - 1 - daysBetween(test.day, day)] ?? 0) : 0;
  const series = model.slice(-STORE_SHOWN_DAYS).map((v) => Math.max(1, v + offset));
  const index = series[series.length - 1] ?? 0;
  const avg30 = meanLogged(days.slice(-30));
  return {
    index,
    band: bandOf(OMEGA3_BANDS, index),
    series,
    avg30,
    test,
    offset,
    settles: Math.max(1, omega3Steady(avg30) + offset),
    gramsForTarget: omega3GramsFor(OMEGA3_TARGET, offset),
  };
}

function ferritinOf(intake: Intake, profile: BodyProfile, day: string): BodySnapshot["ferritin"] {
  const count = storeDays(profile, day);
  const days = loggedDaily(intake, intake.byDay.iron_mg, day, count);
  const test = profile.labs.ferritin;
  const pinAt = test ? { i: count - 1 - daysBetween(test.day, day), value: test.value } : undefined;
  const all = ferritinSeries(days, undefined, pinAt);
  const series = all.slice(-STORE_SHOWN_DAYS);
  const level = series[series.length - 1] ?? 0;
  const avg30 = meanLogged(days.slice(-30));
  return {
    level,
    band: bandOf(FERRITIN_BANDS, level),
    series,
    avg30,
    test,
    settles: ferritinSteady(avg30),
    ironForGood: ironFor(50),
  };
}

function betaAlanineOf(intake: Intake, day: string): BodySnapshot["betaAlanine"] {
  const days = daily(intake.byDay.beta_alanine_g, day, STORE_DAYS);
  const series = betaAlanineStore(days);
  let lastDay: string | null = null;
  for (let i = days.length - 1; i >= 0; i--) {
    if ((days[i] ?? 0) > 0) {
      lastDay = shiftDay(day, i - days.length + 1);
      break;
    }
  }
  return {
    fraction: series[series.length - 1] ?? 0,
    series: series.slice(-STORE_SHOWN_DAYS),
    avg7: days.slice(-7).reduce((a, b) => a + b, 0) / 7,
    lastDay,
  };
}

/** Glycogen's chart: a day back, a day ahead. */
const GLYCOGEN_BACK_H = 24;
const GLYCOGEN_AHEAD_H = 24;
/**
 * History the glycogen simulation warms up on before the chart opens. Muscle
 * takes days to refill, so it needs a week for its assumed starting level to
 * stop mattering.
 */
const GLYCOGEN_WARMUP_H = 7 * 24;
/** Muscle's own history, and the stretch its ins and outs are added up over. */
const MUSCLE_SHOWN_DAYS = 4;

/** How far back ketone readings are fitted against. */
const DRAIN_FIT_DAYS = 60;
/** A reading counts toward the fit when the diary covers this long before it. */
const DRAIN_FIT_COVER_DAYS = 2;

/** One fit per loaded diary, day and set of readings — it reruns the model. */
const drainFits = new WeakMap<Intake, Map<string, DrainFit | null>>();

/**
 * The personal drain rate as of `atMs`. Only readings the diary can account
 * for count: on each of the days leading up to one, something was logged or a
 * fast was running — otherwise an unlogged day would pass for a fasted one.
 */
function drainFitOf(intake: Intake, weightKg: number, atMs: number): DrainFit | null {
  const day = todayStr(new Date(atMs));
  const past = intake.readings.filter((r) => r.ketone != null && r.at <= atMs);
  const key = `${day}:${past.length}:${weightKg}`;
  let cache = drainFits.get(intake);
  if (!cache) drainFits.set(intake, (cache = new Map()));
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  const from = atMs - DRAIN_FIT_DAYS * DAY_MS;
  const covered = (d: string) => intake.loggedDays.has(d) || intake.fastedDays.has(d);
  const usable = past.filter((r) => {
    if (r.at < from) return false;
    const d = todayStr(new Date(r.at));
    for (let i = 0; i <= DRAIN_FIT_COVER_DAYS; i++) if (!covered(shiftDay(d, -i))) return false;
    return true;
  });
  const warm = from - GLYCOGEN_WARMUP_H * HOUR_MS;
  const fit = fitDrain(
    {
      carbs: intake.carbs.filter((d) => d.at >= warm && d.at <= atMs),
      workouts: intake.workouts.filter((w) => w.at >= warm && w.at <= atMs),
      fromMs: from,
      toMs: atMs,
      warmupFromMs: warm,
      weightKg,
    },
    usable,
  );
  cache.set(key, fit);
  return fit;
}

function glycogenOf(intake: Intake, profile: BodyProfile, atMs: number): BodySnapshot["glycogen"] {
  const from = atMs - GLYCOGEN_BACK_H * HOUR_MS;
  const to = atMs + GLYCOGEN_AHEAD_H * HOUR_MS;
  const warm = from - GLYCOGEN_WARMUP_H * HOUR_MS;
  const carbs = intake.carbs.filter((d) => d.at >= warm && d.at <= atMs);
  // A synced workout on a day with nothing logged (and no fast running) would
  // drain muscle that the unlogged meals refilled; leave those days out, so
  // the level holds across them instead.
  const workouts = intake.workouts.filter(
    (w) => w.at >= warm && w.at <= atMs && (intake.loggedDays.has(w.day) || intake.fastedDays.has(w.day)),
  );
  const readings = intake.readings.filter((r) => r.at >= warm && r.at <= atMs);
  const fit = drainFitOf(intake, profile.weightKg, atMs);
  const muscleSince = atMs - MUSCLE_SHOWN_DAYS * DAY_MS;
  // The chart's window is the last day; muscle's story is the last few.
  const run = simulateGlycogen({
    carbs,
    workouts,
    readings,
    fromMs: muscleSince,
    ledgerFromMs: muscleSince,
    toMs: to,
    warmupFromMs: warm,
    weightKg: profile.weightKg,
    drain: fit?.drain ?? 1,
  });
  const points = run.points.filter((p) => p.t >= from);
  const checks = run.checks.filter((c) => c.reading.at >= from);
  const nowPoint = points.filter((p) => p.t <= atMs).pop();
  const last = readings.filter((r) => r.ketone != null && r.at >= atMs - 48 * HOUR_MS).pop();
  const series = liverSeries(points);
  return {
    liver: nowPoint?.liver ?? 0,
    muscle: nowPoint?.muscle ?? 0,
    muscleG: (nowPoint?.muscle ?? 0) * run.muscleCapG,
    muscleCapG: run.muscleCapG,
    muscleBand: bandOf(MUSCLE_BANDS, nowPoint?.muscle ?? 0),
    muscleSeries: run.points.filter((p) => p.t <= atMs).map((p) => p.muscle),
    muscleBurnedG: run.muscleBurnedG,
    muscleRefilledG: run.muscleRefilledG,
    muscleSinceMs: muscleSince,
    muscleWorkouts: workouts
      .filter((w) => w.at >= muscleSince)
      .map((w) => ({ at: w.at, grams: muscleCostG(w) })),
    curve: {
      now: (nowPoint?.liver ?? 0) * 100,
      series,
      doses: carbs.filter((d) => d.at >= from && d.amount >= 10),
      from,
      to,
    },
    ketosisAt: liverBelowAt(points, atMs, LIVER_KETOSIS),
    ketone: nowPoint?.ketone ?? 0,
    ketoneCurve: ketoneSeries(points),
    lastKetone: last?.ketone != null ? { at: last.at, value: last.ketone } : null,
    checks,
    fit,
    hasData: carbs.length > 0 || workouts.length > 0,
  };
}

function trainingOf(intake: Intake, day: string, atMs: number): BodySnapshot["training"] {
  const loads = new Map<string, number>();
  for (const w of intake.workouts) {
    if (w.at <= atMs) loads.set(w.day, (loads.get(w.day) ?? 0) + loadOf(w));
  }
  const days = daily(loads, day, STORE_DAYS);
  const series = trainingLoad(days);
  const last = series[series.length - 1] ?? { fitness: 0, fatigue: 0 };
  const modelRatio = last.fitness >= TRAINING.minFitness ? last.fatigue / last.fitness : null;
  const weekAgo = shiftDay(day, -6);
  const monthAgo = shiftDay(day, -27);
  const recent = intake.workouts.filter((w) => w.day >= monthAgo && w.day <= day && w.at <= atMs);

  // Garmin's own read: the newest day on or before this one that has one,
  // if it isn't stale. Its acute ÷ chronic is what the watch shows, so it
  // wins over the model's when both exist.
  const garmin =
    intake.garminDays
      .filter((g) => g.day <= day && g.day >= shiftDay(day, -GARMIN_FRESH_DAYS))
      .filter((g) => g.status != null || g.acute != null || g.readiness != null || g.hrvStatus != null)
      .sort((a, b) => b.day.localeCompare(a.day))[0] ?? null;
  const garminRatio =
    garmin?.acute != null && garmin.chronic != null && garmin.chronic > 0
      ? garmin.acute / garmin.chronic
      : null;
  const ratio = garminRatio ?? modelRatio;

  return {
    fitness: last.fitness,
    fatigue: last.fatigue,
    ratio,
    ratioFrom: garminRatio != null ? "garmin" : "model",
    band: ratio == null ? null : bandOf(TRAINING_BANDS, ratio),
    fitnessSeries: series.slice(-STORE_SHOWN_DAYS).map((d) => d.fitness * TRAINING.weekly),
    fatigueSeries: series.slice(-STORE_SHOWN_DAYS).map((d) => d.fatigue * TRAINING.weekly),
    sessions7: intake.workouts.filter((w) => w.day >= weekAgo && w.day <= day && w.at <= atMs).length,
    garminCounted: recent.filter((w) => w.garminLoad != null).length,
    workouts28: recent.length,
    garmin,
    focus: focusFor(intake, recent, day),
  };
}

/**
 * The month's load by kind: Garmin's own when it has sent one lately (it
 * comes with personal targets), else summed here from the workouts.
 */
function focusFor(intake: Intake, recent: WorkoutBurn[], day: string): TrainingFocus {
  const g = intake.garminBalance;
  if (g && g.day <= day && g.day >= shiftDay(day, -GARMIN_FRESH_DAYS)) {
    const b = g.balance;
    return {
      from: "garmin",
      low: b.low,
      high: b.high,
      anaerobic: b.anaerobic,
      unplaced: 0,
      targets: { low: b.lowTarget, high: b.highTarget, anaerobic: b.anaerobicTarget },
      feedback: b.feedback,
    };
  }
  const t = focusTotals(recent);
  return {
    from: "model",
    ...t,
    targets: { low: null, high: null, anaerobic: null },
    feedback: null,
  };
}

function sleepOf(intake: Intake, profile: BodyProfile, day: string): BodySnapshot["sleep"] {
  const count = SLEEP_SHOWN_NIGHTS + 30;
  const nights = Array.from({ length: count }, (_, i) => intake.sleepByNight.get(shiftDay(day, i - count + 1)) ?? null);
  const series = sleepDebt(nights, profile.sleepNeedH);
  const debtH = series[series.length - 1] ?? 0;
  const last7 = nights.slice(-7).filter((h): h is number => h != null);
  return {
    debtH,
    band: bandOf(SLEEP_BANDS, debtH),
    series: series.slice(-SLEEP_SHOWN_NIGHTS),
    avg7H: last7.length ? last7.reduce((a, b) => a + b, 0) / last7.length : null,
    needH: profile.sleepNeedH,
    nights14: nights.slice(-14).filter((h) => h != null).length,
  };
}

/** How far ahead the vitamin D projection looks: about four half-lives. */
const PROJECT_DAYS = 60;

function vitaminDOf(intake: Intake, profile: BodyProfile, day: string): BodySnapshot["vitaminD"] {
  const count = storeDays(profile, day);
  const ug = daily(intake.vitaminDByDay, day, count);
  const contrib = vitaminDContribution(ug);
  const dayAt = (i: number) => shiftDay(day, i - count + 1);

  const test = profile.labs.vitaminD;
  let offset = 0;
  if (test) {
    const i = count - 1 - daysBetween(test.day, day);
    const atTest = contrib.series[i] ?? 0;
    offset = test.value - vitaminDBaseline(noonOf(test.day)) - atTest;
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
export { BETA_ALANINE };
