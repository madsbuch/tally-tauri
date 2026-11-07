import { invoke } from "@tauri-apps/api/core";
import { deleteSetting, getSetting, setSetting, todayStr } from "./db";
import { SETTING_KEYS } from "./types";
import { notifyDiaryChanged } from "./agent";
import { shiftDay } from "./daystamp";
import {
  activitiesMissingLaps,
  earliestGarminActivityAt,
  fillHealthMetricsFromGarmin,
  fillSleepFromGarmin,
  garminDayHasData,
  linkGarminActivity,
  setGarminLaps,
  upsertGarminDay,
} from "./garminDb";
import type { GarminDayRow, LinkOutcome } from "./garminDb";
import {
  parseGarminActivities,
  parseGarminCmdError,
  parseGarminDailySummary,
  parseGarminHrv,
  parseGarminLoginResult,
  parseGarminProfile,
  parseGarminReadiness,
  parseGarminSleep,
  parseGarminSplits,
  parseGarminStatus,
  parseGarminTrainingStatus,
  parseGarminWeights,
} from "./schemas";
import type { GarminCmdError, GarminStatus } from "./schemas";

// ---------------------------------------------------------------------------
// Garmin Connect sync — straight from Garmin, through an unofficial sign-in
// (src-tauri/garmin), for everything Health Connect doesn't carry: Training
// Effect, training load, HR-zone time, laps and power per activity; Body
// Battery, stress, training readiness and status, sleep score and HRV status
// per day. Health Connect stays the source for the diary's own rows; this
// attaches detail to them and fills their gaps (see lib/garminDb.ts).
//
// Being an unofficial API, it's polite on purpose: requests go one at a time
// with a pause between, automatic syncs at most every few hours, history is
// backfilled a chunk per sync, and a rate limit stops everything for a day.
// It will break when Garmin changes its sign-in; errors say so plainly.
// ---------------------------------------------------------------------------

/** Automatic syncs (app start / resume) no closer together than this. */
const AUTO_SYNC_MIN_MS = 3 * 3_600_000;
/** Gap between consecutive requests. */
const REQUEST_GAP_MS = 400;
/** After a 429, leave Garmin alone this long. */
const RATE_LIMIT_PAUSE_MS = 24 * 3_600_000;
/** Days of wellness history fetched per sync while backfilling (5 requests each). */
const BACKFILL_CHUNK_DAYS = 14;
/** Never backfill wellness further than this. */
const BACKFILL_MAX_DAYS = 5 * 365;
/** Re-read this many recent days every sync: today is still filling up. */
const RECENT_DAYS = 2;
/** First sync: how many recent days to read before backfilling the rest. */
const FIRST_SYNC_DAYS = 7;
/** Activities page size, and how many pages a full history read may take. */
const PAGE = 100;
const MAX_PAGES = 100;
/** Laps are fetched for activities this recent, a few per sync. */
const LAPS_WINDOW_MS = 30 * 24 * 3_600_000;
const LAPS_PER_SYNC = 10;

export class GarminError extends Error {
  readonly code: string;
  constructor(e: GarminCmdError) {
    super(e.message);
    this.code = e.code;
  }
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw new GarminError(parseGarminCmdError(e));
  }
}

export async function getGarminStatus(): Promise<GarminStatus> {
  try {
    return parseGarminStatus(await invoke("garmin_status"));
  } catch {
    return { connected: false, mfaPending: false };
  }
}

/** Sign in. "mfa" = Garmin sent a code; finish with `submitGarminMfa`. */
export async function loginGarmin(email: string, password: string): Promise<"connected" | "mfa"> {
  return parseGarminLoginResult(await call("garmin_login", { email, password }));
}

export async function submitGarminMfa(code: string): Promise<void> {
  parseGarminLoginResult(await call("garmin_mfa", { code }));
}

/**
 * Forget the sign-in. Synced data stays; the bookmarks go, so connecting
 * again re-reads (and re-links, idempotently) from scratch.
 */
export async function disconnectGarmin(): Promise<void> {
  await call("garmin_logout");
  await Promise.all(
    [
      SETTING_KEYS.garminLastSyncAt,
      SETTING_KEYS.garminDisplayName,
      SETTING_KEYS.garminActivitiesBackfilled,
      SETTING_KEYS.garminWellnessThrough,
      SETTING_KEYS.garminWellnessBackTo,
      SETTING_KEYS.garminPausedUntil,
    ].map((k) => deleteSetting(k)),
  );
}

let lastRequestAt = 0;

/** One paced GET against connectapi.garmin.com; raw JSON out. */
async function garminGet(path: string, query: Record<string, string> = {}): Promise<unknown> {
  const wait = lastRequestAt + REQUEST_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
  return call<unknown>("garmin_get", { path, query: Object.entries(query) });
}

export interface GarminSyncResult {
  /** Activities attached to an existing workout, by how. */
  linkedExact: number;
  linkedByTime: number;
  /** Activities that got a workout of their own (nothing to attach to). */
  created: number;
  /** Already-linked activities refreshed. */
  updated: number;
  laps: number;
  /** Wellness days written this sync. */
  days: number;
  /** Nights added from Garmin where no synced night existed. */
  nights: number;
  /** How far back wellness history reaches now, and whether that's all of it. */
  wellnessBackTo: string | null;
  backfillDone: boolean;
}

export async function getGarminLastSync(): Promise<string | null> {
  return getSetting(SETTING_KEYS.garminLastSyncAt);
}

/** When a rate limit pause ends, if one is on. */
export async function getGarminPausedUntil(): Promise<string | null> {
  const v = await getSetting(SETTING_KEYS.garminPausedUntil);
  return v && Date.parse(v) > Date.now() ? v : null;
}

let inFlight: Promise<GarminSyncResult | null> | null = null;

/**
 * Sync now. `manual` (the Settings button) skips the every-few-hours limit,
 * but never a rate-limit pause. Null = skipped (not connected, too soon, or
 * paused). Concurrent calls join the running one.
 */
export function syncGarmin(opts: { manual?: boolean } = {}): Promise<GarminSyncResult | null> {
  inFlight ??= runSync(opts.manual ?? false).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runSync(manual: boolean): Promise<GarminSyncResult | null> {
  const status = await getGarminStatus();
  if (!status.connected) return null;
  if (await getGarminPausedUntil()) {
    if (manual) throw new GarminError({ code: "rate_limited", message: "Paused after Garmin rate-limited us — try again tomorrow" });
    return null;
  }
  const last = await getGarminLastSync();
  if (!manual && last && Date.now() - Date.parse(last) < AUTO_SYNC_MIN_MS) return null;

  try {
    const result = await syncAll();
    await setSetting(SETTING_KEYS.garminLastSyncAt, new Date().toISOString());
    if (result.linkedExact + result.linkedByTime + result.created + result.days + result.nights > 0) {
      notifyDiaryChanged();
    }
    return result;
  } catch (e) {
    if (e instanceof GarminError && e.code === "rate_limited") {
      await setSetting(
        SETTING_KEYS.garminPausedUntil,
        new Date(Date.now() + RATE_LIMIT_PAUSE_MS).toISOString(),
      );
    }
    throw e;
  }
}

async function displayName(): Promise<string> {
  const cached = await getSetting(SETTING_KEYS.garminDisplayName);
  if (cached) return cached;
  const name = parseGarminProfile(await garminGet("/userprofile-service/socialProfile"));
  if (!name) throw new GarminError({ code: "unexpected", message: "Garmin didn't say who you are (no displayName)" });
  await setSetting(SETTING_KEYS.garminDisplayName, name);
  return name;
}

async function syncAll(): Promise<GarminSyncResult> {
  const result: GarminSyncResult = {
    linkedExact: 0,
    linkedByTime: 0,
    created: 0,
    updated: 0,
    laps: 0,
    days: 0,
    nights: 0,
    wellnessBackTo: null,
    backfillDone: false,
  };
  const tally = (o: LinkOutcome) => {
    if (o === "exact") result.linkedExact++;
    else if (o === "time") result.linkedByTime++;
    else if (o === "created") result.created++;
    else if (o === "updated") result.updated++;
  };

  const user = await displayName();

  // --- Activities: the whole history once, then what's new since last time.
  const backfilled = (await getSetting(SETTING_KEYS.garminActivitiesBackfilled)) === "1";
  const last = await getGarminLastSync();
  const sinceDay = backfilled && last ? shiftDay(last.slice(0, 10), -3) : null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const query: Record<string, string> = { start: String(page * PAGE), limit: String(PAGE) };
    if (sinceDay) query["startDate"] = sinceDay;
    const { activities, raws } = parseGarminActivities(
      await garminGet("/activitylist-service/activities/search/activities", query),
    );
    // Oldest first, so a session made by the first of two near-identical
    // activities can't steal the second's match.
    for (let i = activities.length - 1; i >= 0; i--) {
      tally(await linkGarminActivity(activities[i]!, raws[i]!));
    }
    if (activities.length < PAGE) break;
  }
  if (!backfilled) await setSetting(SETTING_KEYS.garminActivitiesBackfilled, "1");

  // --- Laps for recent activities, a few per sync.
  for (const id of await activitiesMissingLaps(Date.now() - LAPS_WINDOW_MS, LAPS_PER_SYNC)) {
    const laps = parseGarminSplits(await garminGet(`/activity-service/activity/${id}/splits`));
    await setGarminLaps(id, laps);
    result.laps++;
  }

  // --- Wellness: recent days every time, plus one chunk further back.
  const today = todayStr();
  const through = await getSetting(SETTING_KEYS.garminWellnessThrough);
  const recentFrom = through
    ? shiftDay(through, -RECENT_DAYS)
    : shiftDay(today, -(FIRST_SYNC_DAYS - 1));
  const days: string[] = [];
  for (let d = today; d >= recentFrom; d = shiftDay(d, -1)) days.push(d);

  const backTo = (await getSetting(SETTING_KEYS.garminWellnessBackTo)) ?? recentFrom;
  const firstActivity = await earliestGarminActivityAt();
  const floor = [
    shiftDay(today, -BACKFILL_MAX_DAYS),
    firstActivity ? shiftDay(firstActivity.slice(0, 10), -7) : shiftDay(today, -365),
  ].sort()[1]!;
  const backfill: string[] = [];
  for (let d = shiftDay(backTo, -1); d >= floor && backfill.length < BACKFILL_CHUNK_DAYS; d = shiftDay(d, -1)) {
    backfill.push(d);
  }

  const all = [...days, ...backfill];
  const weights = parseGarminWeights(
    await garminGet("/weight-service/weight/dateRange", {
      startDate: all[all.length - 1]!,
      endDate: today,
    }),
  );
  for (const day of all) {
    const row = await fetchDay(user, day, weights.get(day) ?? null);
    await upsertGarminDay(row);
    result.days++;
  }

  await setSetting(SETTING_KEYS.garminWellnessThrough, today);
  const reached = backfill.length > 0 ? backfill[backfill.length - 1]! : backTo;
  await setSetting(SETTING_KEYS.garminWellnessBackTo, reached);
  result.wellnessBackTo = reached;
  result.backfillDone = reached <= floor;

  // --- Fill Health Connect's gaps from what Garmin has.
  await fillHealthMetricsFromGarmin();
  result.nights = await fillSleepFromGarmin();
  return result;
}

async function fetchDay(user: string, day: string, weightKg: number | null): Promise<GarminDayRow> {
  const enc = encodeURIComponent(user);
  const summaryRaw = await garminGet(`/usersummary-service/usersummary/daily/${enc}`, { calendarDate: day });
  const sleepRaw = await garminGet(`/wellness-service/wellness/dailySleepData/${enc}`, {
    date: day,
    nonSleepBufferMinutes: "60",
  });
  const hrvRaw = await garminGet(`/hrv-service/hrv/${day}`);
  const readinessRaw = await garminGet(`/metrics-service/metrics/trainingreadiness/${day}`);
  const statusRaw = await garminGet(`/metrics-service/metrics/trainingstatus/aggregated/${day}`);

  const s = parseGarminDailySummary(summaryRaw);
  const sleep = parseGarminSleep(sleepRaw);
  const hrv = parseGarminHrv(hrvRaw);
  const readiness = parseGarminReadiness(readinessRaw);
  const ts = parseGarminTrainingStatus(statusRaw);
  const n = sleep.night;

  const row: GarminDayRow = {
    day,
    steps: s?.totalSteps != null ? Math.round(s.totalSteps) : null,
    caloriesTotal: s?.totalKilocalories ?? null,
    caloriesActive: s?.activeKilocalories ?? null,
    restingHr: s?.restingHeartRate ?? null,
    minHr: s?.minHeartRate ?? null,
    maxHr: s?.maxHeartRate ?? null,
    stressAvg: s?.averageStressLevel ?? null,
    stressMax: s?.maxStressLevel ?? null,
    bodyBatteryHigh: s?.bodyBatteryHighestValue ?? null,
    bodyBatteryLow: s?.bodyBatteryLowestValue ?? null,
    bodyBatteryCharged: s?.bodyBatteryChargedValue ?? null,
    bodyBatteryDrained: s?.bodyBatteryDrainedValue ?? null,
    bodyBatteryWake: s?.bodyBatteryAtWakeTime ?? null,
    respirationAvg: s?.avgWakingRespirationValue ?? null,
    spo2Avg: s?.averageSpo2 ?? null,
    spo2Low: s?.lowestSpo2 ?? null,
    floorsUp: s?.floorsAscended ?? null,
    intensityMinModerate: s?.moderateIntensityMinutes ?? null,
    intensityMinVigorous: s?.vigorousIntensityMinutes ?? null,
    readinessScore: readiness.score,
    readinessLevel: readiness.level,
    trainingStatus: ts.status,
    acuteLoad: ts.acuteLoad,
    chronicLoad: ts.chronicLoad,
    hrvLastNight: hrv.lastNight,
    hrvWeeklyAvg: hrv.weeklyAvg,
    hrvStatus: hrv.status,
    vo2Max: ts.vo2Max,
    weightKg,
    sleepScore: sleep.score,
    sleepStress: sleep.stress,
    sleepRespiration: sleep.respiration,
    sleepBodyBattery: sleep.bodyBatteryChange,
    sleepId: n?.id ?? null,
    sleepStartedAt: n ? new Date(n.startMs).toISOString() : null,
    sleepEndedAt: n ? new Date(n.endMs).toISOString() : null,
    sleepTzOffsetMin: n?.offsetMin ?? null,
    sleepDeepMin: n?.deepMin ?? null,
    sleepRemMin: n?.remMin ?? null,
    sleepLightMin: n?.lightMin ?? null,
    sleepAwakeMin: n?.awakeMin ?? null,
    raw: {
      summary: summaryRaw,
      sleep: sleep.raw,
      hrv: hrv.raw,
      readiness: readinessRaw,
      trainingStatus: ts.raw,
    },
    fetchedAt: new Date().toISOString(),
  };
  // Mark empty days explicitly in the log, so a silent account is noticed.
  if (!garminDayHasData(row)) console.info(`Garmin had nothing for ${day}`);
  return row;
}

/** The same on the way back to the foreground — self-throttled. */
export function syncGarminIfStale(): Promise<GarminSyncResult | null> {
  return syncGarmin();
}

/** Human-readable error for Settings. */
export function garminErrorMessage(e: unknown): string {
  if (e instanceof GarminError) {
    if (e.code === "blocked" || e.code === "unexpected" || e.code === "http") {
      return `${e.message}. Garmin may have changed its sign-in — this needs a code update.`;
    }
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}
