import { invoke } from "@tauri-apps/api/core";
import { getSetting, setSetting, upsertExternalWorkout } from "./db";
import { SETTING_KEYS } from "./types";
import { notifyDiaryChanged } from "./agent";

// ---------------------------------------------------------------------------
// Health Connect sync — pulls exercise sessions the Garmin Connect app (or any
// other fitness app) writes into Android Health Connect and upserts them into
// the local `workouts` table. Everything stays on-device.
// ---------------------------------------------------------------------------

export type HealthConnectAvailability = "available" | "updateRequired" | "unavailable";

export interface HealthConnectStatus {
  availability: HealthConnectAvailability;
  permissionsGranted: boolean;
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

/** Health Connect only serves apps ~30 days of history. */
const MAX_WINDOW_MS = 30 * 24 * 3_600_000;
/**
 * Re-read this far behind the last sync: the watch may upload an activity
 * hours after it happened, and edits in Garmin Connect should flow through.
 */
const SYNC_OVERLAP_MS = 48 * 3_600_000;

export async function getHealthConnectStatus(): Promise<HealthConnectStatus> {
  try {
    return await invoke<HealthConnectStatus>("plugin:health-connect|get_status");
  } catch (e) {
    console.warn("Health Connect status check failed", e);
    return { availability: "unavailable", permissionsGranted: false };
  }
}

/** Opens the Health Connect per-type permission sheet. */
export async function requestHealthConnectPermissions(): Promise<boolean> {
  const res = await invoke<{ granted: boolean }>(
    "plugin:health-connect|request_permissions",
  );
  return res.granted;
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
  /** Sessions written (inserted or refreshed) — 0 when unavailable/ungranted. */
  synced: number;
}

/**
 * Pull exercise sessions from Health Connect into the workouts table.
 * Safe to call on every app start: no-ops quickly when Health Connect is
 * unavailable or permissions haven't been granted, and re-syncing is
 * idempotent (keyed on the Health Connect record UID).
 */
export async function syncHealthConnectWorkouts(): Promise<HealthConnectSyncResult> {
  const status = await getHealthConnectStatus();
  if (status.availability !== "available" || !status.permissionsGranted) {
    return { status, synced: 0 };
  }

  const now = Date.now();
  const last = await getSetting(SETTING_KEYS.healthConnectLastSyncAt);
  const lastMs = last ? new Date(last).getTime() : NaN;
  const startMs = Math.max(
    now - MAX_WINDOW_MS,
    isFinite(lastMs) ? lastMs - SYNC_OVERLAP_MS : 0,
  );

  const { sessions } = await invoke<{ sessions: HCExerciseSession[] }>(
    "plugin:health-connect|read_exercise_sessions",
    { startMs, endMs: now },
  );

  let synced = 0;
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
    synced++;
  }

  await setSetting(SETTING_KEYS.healthConnectLastSyncAt, new Date(now).toISOString());
  if (synced > 0) notifyDiaryChanged();
  return { status, synced };
}
