import { invoke } from "@tauri-apps/api/core";
import { deleteSetting, getSetting, setSetting, todayStr } from "./db";
import { SETTING_KEYS } from "./types";
import { notifyDiaryChanged } from "./agent";
import { shiftDay } from "./daystamp";
import { getCardioZone2Share } from "./goals";
import {
  activitiesMissingLaps,
  applyZone2Cardio,
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
  parseGarminDailySummariesV2,
  parseGarminDailySummary,
  parseGarminHrv,
  parseGarminHrvDaily,
  parseGarminLaps,
  parseGarminLoginResult,
  parseGarminProfile,
  parseGarminReadiness,
  parseGarminSleep,
  parseGarminSleepList,
  parseGarminStatus,
  parseGarminTrainingStatus,
  parseGarminWeights,
} from "./schemas";
import type { GarminCmdError, GarminSleep, GarminStatus } from "./schemas";

// ---------------------------------------------------------------------------
// Garmin Connect sync — straight from Garmin, for everything Health Connect
// doesn't carry: Training Effect, training load, HR-zone time, power and laps
// per activity; Body Battery, stress, HRV status, sleep score per day. Health
// Connect stays the source for the diary's own rows; this attaches detail to
// them and fills their gaps (see lib/garminDb.ts).
//
// Two ways in (src-tauri/src/garmin.rs):
//  - the official Personal API key — the main one. Range endpoints, so a
//    month of wellness is four requests;
//  - the unofficial sign-in, optional — on its own it does everything the old
//    way; next to a key it only adds what the Personal API doesn't serve:
//    training readiness and training status, for recent days.
//
// Polite either way: one request at a time with a pause between, automatic
// syncs at most every few hours, history backfilled a chunk per sync, and a
// rate limit stops everything for a day.
// ---------------------------------------------------------------------------

/** Automatic syncs (app start / resume) no closer together than this. */
const AUTO_SYNC_MIN_MS = 3 * 3_600_000;
/**
 * After Health Connect brings in a new workout, sync no closer to the last
 * sync than this: enough to keep a burst of uploads to one round of requests.
 */
const NEW_WORKOUT_SYNC_MIN_MS = 2 * 60_000;
/** Gap between consecutive requests. */
const REQUEST_GAP_MS = 400;
/** After a 429, leave Garmin alone this long. */
const RATE_LIMIT_PAUSE_MS = 24 * 3_600_000;
/**
 * Days of wellness history fetched per sync while backfilling: cheap with the
 * Personal API's range endpoints, five requests a day with the sign-in alone.
 */
const BACKFILL_CHUNK_DAYS_PERSONAL = 180;
const BACKFILL_CHUNK_DAYS_LEGACY = 14;
/** Longest range asked of one Personal API range endpoint. */
const RANGE_WINDOW_DAYS = 28;
/** Never backfill wellness further than this. */
const BACKFILL_MAX_DAYS = 5 * 365;
/** Re-read this many recent days every sync: today is still filling up. */
const RECENT_DAYS = 2;
/** First sync: how many recent days to read before backfilling the rest. */
const FIRST_SYNC_DAYS = 7;
/** Activities page size, and how many pages a full history read may take. */
const PAGE = 100;
const MAX_PAGES = 100;
/** Laps (from each activity's FIT file) for activities this recent, a few per sync. */
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
    return { personal: false, connected: false, mfaPending: false };
  }
}

/** Store a Personal API key; throws (code "invalid_key") if Garmin refuses it. */
export async function setGarminKey(key: string): Promise<void> {
  await call("garmin_set_key", { key });
}

/** Sign in (unofficial). "mfa" = Garmin sent a code; finish with `submitGarminMfa`. */
export async function loginGarmin(email: string, password: string): Promise<"connected" | "mfa"> {
  return parseGarminLoginResult(await call("garmin_login", { email, password }));
}

export async function submitGarminMfa(code: string): Promise<void> {
  parseGarminLoginResult(await call("garmin_mfa", { code }));
}

const BOOKMARKS = [
  SETTING_KEYS.garminLastSyncAt,
  SETTING_KEYS.garminDisplayName,
  SETTING_KEYS.garminActivitiesBackfilled,
  SETTING_KEYS.garminWellnessThrough,
  SETTING_KEYS.garminWellnessBackTo,
  SETTING_KEYS.garminPausedUntil,
];

/**
 * Forget the key (`"key"`) or the sign-in (`"signin"`). Synced data stays.
 * Once neither is left the bookmarks go too, so connecting again re-reads
 * (and re-links, idempotently) from scratch.
 */
export async function disconnectGarmin(which: "key" | "signin"): Promise<void> {
  await call(which === "key" ? "garmin_clear_key" : "garmin_logout");
  const s = await getGarminStatus();
  if (!s.personal && !s.connected) await Promise.all(BOOKMARKS.map((k) => deleteSetting(k)));
}

let lastRequestAt = 0;

async function paced(): Promise<void> {
  const wait = lastRequestAt + REQUEST_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
}

/**
 * One paced GET; raw JSON out. `source` picks the way in — by default the
 * Personal API when a key is set, else the sign-in.
 */
async function garminGet(
  path: string,
  query: Record<string, string> = {},
  source?: "personal" | "legacy",
): Promise<unknown> {
  await paced();
  return call<unknown>("garmin_get", { path, query: Object.entries(query), source });
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
  /** Workouts the Zone 2 rule switched on or off as cardio. */
  zone2Cardio: number;
  /** How far back wellness history reaches now, and whether that's all of it. */
  wellnessBackTo: string | null;
  backfillDone: boolean;
  /** Why readiness/training status (sign-in extras) were skipped, if they were. */
  extrasError: string | null;
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
 * but never a rate-limit pause; so does `newWorkout` (Health Connect just
 * brought one in), silently. Null = skipped (not connected, too soon, or
 * paused). Concurrent calls join the running one.
 */
export function syncGarmin(
  opts: { manual?: boolean; newWorkout?: boolean } = {},
): Promise<GarminSyncResult | null> {
  inFlight ??= runSync(opts.manual ?? false, opts.newWorkout ?? false).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runSync(manual: boolean, newWorkout: boolean): Promise<GarminSyncResult | null> {
  const status = await getGarminStatus();
  if (!status.personal && !status.connected) return null;
  if (await getGarminPausedUntil()) {
    if (manual) {
      throw new GarminError({
        code: "rate_limited",
        message: "Paused after Garmin rate-limited us. Try again tomorrow",
      });
    }
    return null;
  }
  const last = await getGarminLastSync();
  // A workout just showed up in Health Connect: Garmin has it too by now
  // (Garmin Connect writes it there after its own upload), so fetch its
  // zones, Training Effect and laps while it's the one being looked at.
  const minGap = manual ? 0 : newWorkout ? NEW_WORKOUT_SYNC_MIN_MS : AUTO_SYNC_MIN_MS;
  if (last && Date.now() - Date.parse(last) < minGap) return null;

  try {
    const result = await syncAll(status);
    await setSetting(SETTING_KEYS.garminLastSyncAt, new Date().toISOString());
    if (result.linkedExact + result.linkedByTime + result.created + result.days + result.nights + result.zone2Cardio > 0) {
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

/** The unofficial API's per-user endpoints need Garmin's displayName. */
async function displayName(): Promise<string> {
  const cached = await getSetting(SETTING_KEYS.garminDisplayName);
  if (cached) return cached;
  const name = parseGarminProfile(await garminGet("/userprofile-service/socialProfile", {}, "legacy"));
  if (!name) {
    throw new GarminError({ code: "unexpected", message: "Garmin didn't say who you are (no displayName)" });
  }
  await setSetting(SETTING_KEYS.garminDisplayName, name);
  return name;
}

async function syncAll(status: GarminStatus): Promise<GarminSyncResult> {
  const result: GarminSyncResult = {
    linkedExact: 0,
    linkedByTime: 0,
    created: 0,
    updated: 0,
    laps: 0,
    days: 0,
    nights: 0,
    zone2Cardio: 0,
    wellnessBackTo: null,
    backfillDone: false,
    extrasError: null,
  };
  const tally = (o: LinkOutcome) => {
    if (o === "exact") result.linkedExact++;
    else if (o === "time") result.linkedByTime++;
    else if (o === "created") result.created++;
    else if (o === "updated") result.updated++;
  };

  // --- Activities: the whole history once, then what's new since last time.
  // Same endpoint and shape on both ways in.
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

  // --- Laps for recent activities, out of their FIT files, a few per sync.
  for (const id of await activitiesMissingLaps(Date.now() - LAPS_WINDOW_MS, LAPS_PER_SYNC)) {
    await paced();
    const laps = parseGarminLaps(await call("garmin_activity_laps", { activityId: id }));
    await setGarminLaps(id, laps);
    result.laps++;
  }

  // --- Wellness: recent days every time, plus one chunk further back.
  const today = todayStr();
  const through = await getSetting(SETTING_KEYS.garminWellnessThrough);
  const recentFrom = through ? shiftDay(through, -RECENT_DAYS) : shiftDay(today, -(FIRST_SYNC_DAYS - 1));
  const backTo = (await getSetting(SETTING_KEYS.garminWellnessBackTo)) ?? recentFrom;
  const firstActivity = await earliestGarminActivityAt();
  const floor = [
    shiftDay(today, -BACKFILL_MAX_DAYS),
    firstActivity ? shiftDay(firstActivity.slice(0, 10), -7) : shiftDay(today, -365),
  ].sort()[1]!;
  const chunk = status.personal ? BACKFILL_CHUNK_DAYS_PERSONAL : BACKFILL_CHUNK_DAYS_LEGACY;
  let backfillFrom = shiftDay(backTo, -chunk);
  if (backfillFrom < floor) backfillFrom = floor;
  const backfillTo = shiftDay(backTo, -1);

  // Ranges, oldest-first not needed — each day is written on its own.
  const ranges: [string, string][] = [[recentFrom, today]];
  if (backfillFrom <= backfillTo) ranges.push([backfillFrom, backfillTo]);

  for (const [from, to] of ranges) {
    const rows = status.personal ? await personalDays(from, to) : await legacyDays(from, to);
    for (const row of rows) {
      await upsertGarminDay(row);
      result.days++;
    }
  }

  // Readiness and training status exist only on the unofficial side: with a
  // key, the sign-in (when there is one) adds them for the recent days.
  if (status.personal && status.connected) {
    try {
      for (const day of daysBetween(recentFrom, today)) {
        await upsertGarminDay({ day, ...(await legacyExtras(day)), fetchedAt: new Date().toISOString() });
      }
    } catch (e) {
      result.extrasError = garminErrorMessage(e);
    }
  }

  await setSetting(SETTING_KEYS.garminWellnessThrough, today);
  const reached = backfillFrom <= backfillTo ? backfillFrom : backTo;
  await setSetting(SETTING_KEYS.garminWellnessBackTo, reached);
  result.wellnessBackTo = reached;
  result.backfillDone = reached <= floor;

  // --- Fill Health Connect's gaps from what Garmin has.
  await fillHealthMetricsFromGarmin();
  result.nights = await fillSleepFromGarmin();
  // --- Workouts mostly in Zone 2 count as cardio, now their zones are in.
  result.zone2Cardio = await applyZone2Cardio(await getCardioZone2Share());
  return result;
}

/** Every day from `from` to `to`, inclusive, newest first. */
function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = to; d >= from; d = shiftDay(d, -1)) out.push(d);
  return out;
}

function sleepColumns(sleep: GarminSleep | undefined): Partial<GarminDayRow> {
  if (!sleep) return {};
  const n = sleep.night;
  return {
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
  };
}

/**
 * Personal API: a span of days from four range endpoints, asked in windows
 * of a few weeks — daily summaries, HRV, sleep and weight.
 */
async function personalDays(from: string, to: string): Promise<GarminDayRow[]> {
  const rows: GarminDayRow[] = [];
  for (let end = to; end >= from; end = shiftDay(end, -RANGE_WINDOW_DAYS)) {
    let start = shiftDay(end, -(RANGE_WINDOW_DAYS - 1));
    if (start < from) start = from;

    const summaries = parseGarminDailySummariesV2(
      await garminGet("/usersummary-service/v2/dailysummaries", { startDate: start, endDate: end }),
    );
    const hrv = parseGarminHrvDaily(await garminGet(`/hrv-service/hrv/daily/${start}/${end}`));
    const sleeps = new Map<string, GarminSleep>();
    for (const s of parseGarminSleepList(
      await garminGet("/sleep-service/sleep/dailySleepSummariesByDate", { startDate: start, endDate: end }),
    )) {
      if (s.day) sleeps.set(s.day, s);
    }
    const weights = parseGarminWeights(await garminGet(`/weight-service/weight/range/${start}/${end}`));

    for (const day of daysBetween(start, end)) {
      const s = summaries.get(day);
      const h = hrv.get(day);
      const sleep = sleeps.get(day);
      const row: GarminDayRow = {
        day,
        steps: s?.steps != null ? Math.round(s.steps) : null,
        caloriesTotal: s?.caloriesTotal ?? null,
        caloriesActive: s?.caloriesActive ?? null,
        restingHr: s?.restingHr ?? null,
        minHr: s?.minHr ?? null,
        maxHr: s?.maxHr ?? null,
        stressAvg: s?.stressAvg ?? null,
        stressMax: s?.stressMax ?? null,
        bodyBatteryHigh: s?.bodyBatteryHigh ?? null,
        bodyBatteryLow: s?.bodyBatteryLow ?? null,
        bodyBatteryCharged: s?.bodyBatteryCharged ?? null,
        bodyBatteryDrained: s?.bodyBatteryDrained ?? null,
        respirationAvg: s?.respirationAvg ?? null,
        spo2Avg: s?.spo2Avg ?? null,
        spo2Low: s?.spo2Low ?? null,
        floorsUp: s?.floors ?? null,
        intensityMinModerate: s?.intensityModerate ?? null,
        intensityMinVigorous: s?.intensityVigorous ?? null,
        hrvLastNight: h?.lastNight ?? null,
        hrvWeeklyAvg: h?.weeklyAvg ?? null,
        hrvStatus: h?.status ?? null,
        weightKg: weights.get(day) ?? null,
        ...sleepColumns(sleep),
        raw: { dailySummary: s?.raw ?? null, hrvSummary: h?.raw ?? null, dailySleep: sleep?.raw ?? null },
        fetchedAt: new Date().toISOString(),
      };
      if (garminDayHasData(row)) rows.push(row);
    }
  }
  return rows;
}

/** Sign-in only: readiness and training status for one day. */
async function legacyExtras(day: string): Promise<Partial<GarminDayRow>> {
  const readinessRaw = await garminGet(`/metrics-service/metrics/trainingreadiness/${day}`, {}, "legacy");
  const statusRaw = await garminGet(`/metrics-service/metrics/trainingstatus/aggregated/${day}`, {}, "legacy");
  const readiness = parseGarminReadiness(readinessRaw);
  const ts = parseGarminTrainingStatus(statusRaw);
  return {
    readinessScore: readiness.score,
    readinessLevel: readiness.level,
    trainingStatus: ts.status,
    acuteLoad: ts.acuteLoad,
    chronicLoad: ts.chronicLoad,
    vo2Max: ts.vo2Max,
    raw: { readiness: readinessRaw, trainingStatus: ts.raw },
  };
}

/** Sign-in alone (no key): every day from its own five endpoints. */
async function legacyDays(from: string, to: string): Promise<GarminDayRow[]> {
  const user = await displayName();
  const enc = encodeURIComponent(user);
  const weights = parseGarminWeights(
    await garminGet("/weight-service/weight/dateRange", { startDate: from, endDate: to }, "legacy"),
  );
  const rows: GarminDayRow[] = [];
  for (const day of daysBetween(from, to)) {
    const summaryRaw = await garminGet(`/usersummary-service/usersummary/daily/${enc}`, { calendarDate: day }, "legacy");
    const sleepRaw = await garminGet(
      `/wellness-service/wellness/dailySleepData/${enc}`,
      { date: day, nonSleepBufferMinutes: "60" },
      "legacy",
    );
    const hrvRaw = await garminGet(`/hrv-service/hrv/${day}`, {}, "legacy");
    const s = parseGarminDailySummary(summaryRaw);
    const hrv = parseGarminHrv(hrvRaw);
    const extras = await legacyExtras(day);
    const sleep = parseGarminSleep(sleepRaw);
    rows.push({
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
      hrvLastNight: hrv.lastNight,
      hrvWeeklyAvg: hrv.weeklyAvg,
      hrvStatus: hrv.status,
      weightKg: weights.get(day) ?? null,
      ...extras,
      ...sleepColumns(sleep),
      raw: {
        ...(extras.raw ?? {}),
        summary: summaryRaw,
        sleep: sleep.raw,
        hrv: hrv.raw,
      },
      fetchedAt: new Date().toISOString(),
    });
  }
  return rows;
}

/**
 * The same on the way back to the foreground, or after a Health Connect
 * sync: self-throttled, unless that sync brought in a new workout.
 */
export function syncGarminIfStale(
  hc?: { newWorkouts: number } | null,
): Promise<GarminSyncResult | null> {
  return syncGarmin({ newWorkout: (hc?.newWorkouts ?? 0) > 0 });
}

/** Human-readable error for Settings. */
export function garminErrorMessage(e: unknown): string {
  if (e instanceof GarminError) {
    if (e.code === "blocked" || e.code === "unexpected" || e.code === "http") {
      return `${e.message}. If this is the unofficial sign-in, Garmin may have changed it, and this needs a code update.`;
    }
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}
