import { invoke } from "@tauri-apps/api/core";
import {
  deleteSetting,
  getSetting,
  setSetting,
  upsertExternalWorkout,
  upsertHealthMetric,
  upsertSleepSession,
} from "./db";
import { SETTING_KEYS } from "./types";
import { notifyDiaryChanged } from "./agent";

// ---------------------------------------------------------------------------
// Health Connect sync — pulls everything the Garmin Connect app (or any other
// fitness app) writes into Android Health Connect and upserts it locally:
// exercise sessions → `workouts`, sleep → `sleep_sessions`, and daily wellness
// aggregates (steps, resting HR, HRV, SpO2, weight, VO2 max, calories) →
// `health_metrics`. Everything stays on-device.
// ---------------------------------------------------------------------------

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
const RESYNC_VERSION = "2";

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
  /** Sleep sessions written. */
  sleep: number;
  /** Days of wellness metrics written. */
  days: number;
}

const num = (v: number | null | undefined): number | null =>
  typeof v === "number" && isFinite(v) ? v : null;

/**
 * Pull workouts, sleep, and daily wellness metrics from Health Connect.
 * Safe to call on every app start: no-ops quickly when Health Connect is
 * unavailable or permissions haven't been granted, and re-syncing is
 * idempotent (workouts/sleep keyed on the record UID, metrics on the day).
 */
export async function syncHealthConnect(): Promise<HealthConnectSyncResult> {
  const status = await getHealthConnectStatus();
  if (status.availability !== "available" || !status.permissionsGranted) {
    return { status, workouts: 0, sleep: 0, days: 0 };
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
    { startMs, endMs: now },
  );

  let workoutCount = 0;
  for (const s of sessions) {
    const durationMin = Math.round((s.endMs - s.startMs) / 60_000);
    await upsertExternalWorkout({
      performed_at: new Date(s.startMs).toISOString(),
      title: s.title?.trim() || s.exerciseType,
      description: describeSession(s),
      photo_path: null,
      calories_burned: Math.round(s.calories ?? 0),
      duration_min: durationMin > 0 ? durationMin : null,
      model_id: null,
      source: sourceLabel(s.sourcePackage),
      external_id: s.id,
    });
    workoutCount++;
  }

  // Sleep often spans midnight — pad the window start by a day so the night
  // in progress at `startMs` is still picked up whole.
  const { sessions: sleepSessions } = await invoke<{ sessions: HCSleepSession[] }>(
    "plugin:health-connect|read_sleep_sessions",
    { startMs: startMs - 24 * 3_600_000, endMs: now },
  );

  let sleepCount = 0;
  for (const s of sleepSessions) {
    const durationMin = Math.round((s.endMs - s.startMs) / 60_000);
    if (durationMin <= 0) continue;
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
    });
    sleepCount++;
  }

  // Daily aggregates are computed from the records inside the window — extend
  // it back to local midnight so the first day is never a partial recount.
  const windowStart = new Date(startMs);
  windowStart.setHours(0, 0, 0, 0);
  const { days } = await invoke<{ days: HCDailyMetric[] }>(
    "plugin:health-connect|read_daily_metrics",
    { startMs: windowStart.getTime(), endMs: now },
  );

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

  await setSetting(SETTING_KEYS.healthConnectLastSyncAt, new Date(now).toISOString());
  if (status.historyGranted) {
    await setSetting(SETTING_KEYS.healthConnectHistorySynced, "1");
  }
  await setSetting(SETTING_KEYS.healthConnectResyncVersion, RESYNC_VERSION);
  if (workoutCount > 0) notifyDiaryChanged();
  return { status, workouts: workoutCount, sleep: sleepCount, days: dayCount };
}
