import { invoke } from "@tauri-apps/api/core";
import {
  deleteSetting,
  getSetting,
  purgeSyncedDataNotFrom,
  setSetting,
  upsertExternalWorkout,
  upsertHealthMetric,
  upsertSleepSession,
} from "./db";
import { SETTING_KEYS } from "./types";
import { notifyDiaryChanged } from "./agent";
import { dayOf } from "./daystamp";
import { adoptGarminSleep, adoptGarminWorkout, fillHealthMetricsFromGarmin } from "./garminDb";

// ---------------------------------------------------------------------------
// Health Connect sync — pulls what the Garmin Connect app writes into Android
// Health Connect and upserts it locally:
// exercise sessions → `workouts`, sleep → `sleep_sessions`, and daily wellness
// aggregates (steps, resting HR, HRV, SpO2, weight, VO2 max, calories) →
// `health_metrics`. Everything stays on-device.
//
// Only Garmin's records are read. Health Connect otherwise blends in every
// app that writes there (the phone's own step counter, the OEM health app,
// Google Fit…) by its data-origin priority list, and the phone's guess at the
// day's burn can win over the watch's.
// ---------------------------------------------------------------------------

const GARMIN_CONNECT = "com.garmin.android.apps.connectmobile";
const ORIGINS = [GARMIN_CONNECT];

export type HealthConnectAvailability = "available" | "updateRequired" | "unavailable";

export interface HealthConnectStatus {
  availability: HealthConnectAvailability;
  permissionsGranted: boolean;
  /**
   * READ_HEALTH_DATA_HISTORY granted — without it Health Connect only serves
   * data written in the 30 days before the first permission grant.
   */
  historyGranted: boolean;
}

interface HCExerciseSession {
  id: string;
  title?: string | null;
  exerciseType: string;
  startMs: number;
  endMs: number;
  calories?: number | null;
  distanceMeters?: number | null;
  avgHeartRate?: number | null;
  sourcePackage?: string | null;
  /** Minutes east of UTC where it was done, when the record carries it. */
  startOffsetMin?: number | null;
  /** The writing app's own id for the record (Garmin's, when it sets one). */
  clientRecordId?: string | null;
}

interface HCSleepSession {
  id: string;
  title?: string | null;
  startMs: number;
  endMs: number;
  deepMin?: number | null;
  remMin?: number | null;
  lightMin?: number | null;
  awakeMin?: number | null;
  sourcePackage?: string | null;
  /** Minutes east of UTC where the night was slept, when recorded. */
  endOffsetMin?: number | null;
  clientRecordId?: string | null;
}

interface HCDailyMetric {
  day: string;
  steps?: number | null;
  caloriesTotal?: number | null;
  restingHr?: number | null;
  hrvMs?: number | null;
  spo2Pct?: number | null;
  weightKg?: number | null;
  vo2Max?: number | null;
}

/** Without history permission, Health Connect serves ~30 days of history. */
const DEFAULT_WINDOW_MS = 30 * 24 * 3_600_000;
/** With READ_HEALTH_DATA_HISTORY granted, pull up to a year back. */
const HISTORY_WINDOW_MS = 365 * 24 * 3_600_000;
/**
 * Re-read this far behind the last sync: the watch may upload an activity
 * hours after it happened, and edits in Garmin Connect should flow through.
 */
const SYNC_OVERLAP_MS = 48 * 3_600_000;
/**
 * Bump when a sync-logic fix changes what already-synced days should contain
 * (e.g. the switch from summing raw step records to deduplicated aggregates).
 * A mismatch forces one full-window resync so stale values get overwritten.
 */
const RESYNC_VERSION = "3";

export async function getHealthConnectStatus(): Promise<HealthConnectStatus> {
  try {
    const s = await invoke<HealthConnectStatus>("plugin:health-connect|get_status");
    return { ...s, historyGranted: s.historyGranted ?? false };
  } catch (e) {
    console.warn("Health Connect status check failed", e);
    return { availability: "unavailable", permissionsGranted: false, historyGranted: false };
  }
}

/** Opens the Health Connect per-type permission sheet. */
export async function requestHealthConnectPermissions(): Promise<boolean> {
  const res = await invoke<{ granted: boolean }>(
    "plugin:health-connect|request_permissions",
  );
  return res.granted;
}

/**
 * Disconnect: revoke every Health Connect permission so the next connect
 * shows the full permission sheet again (incl. history access). Also clears
 * the sync bookmarks so a reconnect re-reads the whole window from scratch.
 * Already-synced entries stay — re-syncing upserts by record id.
 *
 * Note: on some Android versions the revocation only takes effect after the
 * app restarts.
 */
export async function disconnectHealthConnect(): Promise<void> {
  await invoke("plugin:health-connect|revoke_permissions");
  await deleteSetting(SETTING_KEYS.healthConnectLastSyncAt);
  await deleteSetting(SETTING_KEYS.healthConnectHistorySynced);
}

export async function openHealthConnectSettings(): Promise<void> {
  await invoke("plugin:health-connect|open_settings");
}

/** Maps a Health Connect data-origin package to a friendly source label. */
function sourceLabel(pkg: string | null | undefined): string {
  if (pkg && pkg.startsWith("com.garmin.")) return "Garmin";
  return "Health Connect";
}

/** "Running · 5.3 km · avg HR 142" — whatever stats the session carries. */
function describeSession(s: HCExerciseSession): string {
  const parts: string[] = [s.exerciseType];
  if (s.distanceMeters != null && s.distanceMeters >= 100) {
    parts.push(`${(s.distanceMeters / 1000).toFixed(1)} km`);
  }
  if (s.avgHeartRate != null && s.avgHeartRate > 0) {
    parts.push(`avg HR ${Math.round(s.avgHeartRate)}`);
  }
  return parts.join(" · ");
}

export interface HealthConnectSyncResult {
  status: HealthConnectStatus;
  /** Workout sessions written (inserted or refreshed). */
  workouts: number;
  /**
   * Of those, sessions the diary had never seen: a workout just finished and
   * uploaded. Worth asking Garmin about right away (see _app.tsx).
   */
  newWorkouts: number;
  /** Sleep sessions written. */
  sleep: number;
  /** Days of wellness metrics written. */
  days: number;
}

const num = (v: number | null | undefined): number | null =>
  typeof v === "number" && isFinite(v) ? v : null;

/** Returns to the foreground closer together than this don't read again. */
const RESUME_SYNC_MIN_MS = 5 * 60_000;
let lastSyncStartedAt = 0;
let syncInFlight: Promise<HealthConnectSyncResult> | null = null;

/**
 * Pull workouts, sleep, and daily wellness metrics from Health Connect.
 * Safe to call on every app start: no-ops quickly when Health Connect is
 * unavailable or permissions haven't been granted, and re-syncing is
 * idempotent (workouts/sleep keyed on the record UID, metrics on the day).
 * A call while one is running joins it rather than reading twice.
 */
export function syncHealthConnect(): Promise<HealthConnectSyncResult> {
  syncInFlight ??= runSync().finally(() => {
    syncInFlight = null;
  });
  return syncInFlight;
}

/**
 * The same, on the way back to the foreground. Today's steps and total burn
 * keep climbing while the app sits in the background, and a cold start — the
 * only other automatic sync — can be a day away while Android keeps the
 * process alive, so the Diary showed the afternoon's burn at midnight. Null
 * when the last read was too recent to bother.
 */
export async function syncHealthConnectIfStale(): Promise<HealthConnectSyncResult | null> {
  if (Date.now() - lastSyncStartedAt < RESUME_SYNC_MIN_MS) return null;
  return syncHealthConnect();
}

async function runSync(): Promise<HealthConnectSyncResult> {
  lastSyncStartedAt = Date.now();
  const status = await getHealthConnectStatus();
  if (status.availability !== "available" || !status.permissionsGranted) {
    return { status, workouts: 0, newWorkouts: 0, sleep: 0, days: 0 };
  }

  const now = Date.now();
  const last = await getSetting(SETTING_KEYS.healthConnectLastSyncAt);
  const lastMs = last ? new Date(last).getTime() : NaN;
  const windowMs = status.historyGranted ? HISTORY_WINDOW_MS : DEFAULT_WINDOW_MS;
  // When history access appears (first grant, or granted later in Health
  // Connect), re-read the whole window once instead of resuming incrementally
  // — the newly readable past would otherwise stay invisible forever. Same
  // after a sync-logic fix (RESYNC_VERSION bump): stale day values only heal
  // if the whole window is recomputed once.
  const historyBackfilled = await getSetting(SETTING_KEYS.healthConnectHistorySynced);
  const resyncedVersion = await getSetting(SETTING_KEYS.healthConnectResyncVersion);
  const fullResync =
    (status.historyGranted && !historyBackfilled) || resyncedVersion !== RESYNC_VERSION;
  const startMs = fullResync
    ? now - windowMs
    : Math.max(now - windowMs, isFinite(lastMs) ? lastMs - SYNC_OVERLAP_MS : 0);

  const { sessions } = await invoke<{ sessions: HCExerciseSession[] }>(
    "plugin:health-connect|read_exercise_sessions",
    { startMs, endMs: now, origins: ORIGINS },
  );
  // Sleep often spans midnight — pad the window start by a day so the night
  // in progress at `startMs` is still picked up whole.
  const { sessions: sleepSessions } = await invoke<{ sessions: HCSleepSession[] }>(
    "plugin:health-connect|read_sleep_sessions",
    { startMs: startMs - 24 * 3_600_000, endMs: now, origins: ORIGINS },
  );
  // Daily aggregates are computed from the records inside the window — extend
  // it back to local midnight so the first day is never a partial recount.
  const windowStart = new Date(startMs);
  windowStart.setHours(0, 0, 0, 0);
  const { days } = await invoke<{ days: HCDailyMetric[] }>(
    "plugin:health-connect|read_daily_metrics",
    { startMs: windowStart.getTime(), endMs: now, origins: ORIGINS },
  );

  // A full resync rewrites the window from scratch, so whatever other apps
  // left behind before reads were limited to Garmin goes — including day
  // metrics Garmin has nothing for, which an upsert would otherwise keep.
  // Only once every read above has succeeded, so a failed read loses nothing.
  if (fullResync) await purgeSyncedDataNotFrom("Garmin", dayOf(windowStart.toISOString()));

  // What Garmin puts in clientRecordId decides whether the Garmin Connect
  // sync can match exactly; Settings shows it too.
  const withRecordId = sessions.find((s) => s.clientRecordId);
  if (withRecordId) {
    console.info("Health Connect clientRecordId example:", withRecordId.clientRecordId);
  }

  let workoutCount = 0;
  let newWorkoutCount = 0;
  for (const s of sessions) {
    const durationMin = Math.round((s.endMs - s.startMs) / 60_000);
    // A session the Garmin Connect sync got to first is taken over, not
    // written twice.
    const seen = await adoptGarminWorkout(s.id, s.clientRecordId, { startMs: s.startMs, endMs: s.endMs });
    if (seen === "new") newWorkoutCount++;
    await upsertExternalWorkout({
      performed_at: new Date(s.startMs).toISOString(),
      title: s.title?.trim() || s.exerciseType,
      description: describeSession(s),
      photo_path: null,
      calories_burned: Math.round(s.calories ?? 0),
      duration_min: durationMin > 0 ? durationMin : null,
      model_id: null,
      // Left unset: the timeline derives an icon from the activity title, and
      // a re-sync must not overwrite one the user picked by hand.
      icon: null,
      source: sourceLabel(s.sourcePackage),
      external_id: s.id,
      // The watch knows where you were; without that the day would be read in
      // whatever zone the phone is in when the sync happens to run.
      tz_offset_min: num(s.startOffsetMin),
      source_record_id: s.clientRecordId ?? null,
    });
    workoutCount++;
  }

  let sleepCount = 0;
  for (const s of sleepSessions) {
    const durationMin = Math.round((s.endMs - s.startMs) / 60_000);
    if (durationMin <= 0) continue;
    await adoptGarminSleep(s.id, { startMs: s.startMs, endMs: s.endMs });
    await upsertSleepSession({
      external_id: s.id,
      started_at: new Date(s.startMs).toISOString(),
      ended_at: new Date(s.endMs).toISOString(),
      duration_min: durationMin,
      deep_min: num(s.deepMin),
      rem_min: num(s.remMin),
      light_min: num(s.lightMin),
      awake_min: num(s.awakeMin),
      source: sourceLabel(s.sourcePackage),
      tz_offset_min: num(s.endOffsetMin),
      source_record_id: s.clientRecordId ?? null,
    });
    sleepCount++;
  }

  let dayCount = 0;
  for (const d of days) {
    await upsertHealthMetric({
      day: d.day,
      steps: num(d.steps) != null ? Math.round(d.steps as number) : null,
      resting_hr: num(d.restingHr),
      hrv_ms: num(d.hrvMs),
      spo2_pct: num(d.spo2Pct),
      weight_kg: num(d.weightKg),
      vo2_max: num(d.vo2Max),
      calories_total: num(d.caloriesTotal),
    });
    dayCount++;
  }
  // Days and fields Health Connect has nothing for come from the Garmin
  // Connect sync, when it's on — a full resync above just wiped them.
  await fillHealthMetricsFromGarmin();

  await setSetting(SETTING_KEYS.healthConnectLastSyncAt, new Date(now).toISOString());
  if (status.historyGranted) {
    await setSetting(SETTING_KEYS.healthConnectHistorySynced, "1");
  }
  await setSetting(SETTING_KEYS.healthConnectResyncVersion, RESYNC_VERSION);
  // Day metrics count too: the Diary's steps and total burn come from them.
  if (workoutCount > 0 || sleepCount > 0 || dayCount > 0) notifyDiaryChanged();
  return { status, workouts: workoutCount, newWorkouts: newWorkoutCount, sleep: sleepCount, days: dayCount };
}
