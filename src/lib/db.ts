import Database from "@tauri-apps/plugin-sql";
import { invoke } from "@tauri-apps/api/core";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import {
  achievements,
  aiUsage,
  bloodReadings,
  captures,
  chats,
  coachMemory,
  manuals,
  manualRevisions,
  experiments,
  experimentTrials,
  coachRuns,
  dayGoalAdjustments,
  documents,
  entryMessages,
  entryNotes,
  fasts,
  foodEntries,
  garminActivities,
  healthMetrics,
  incompleteDays,
  performanceLogs,
  performanceStats,
  progressPhotos,
  savedMeals,
  settings,
  sleepSessions,
  stateCategories,
  stateLogs,
  supplementLogs,
  supplements,
  workouts,
} from "../db/schema";
import type {
  BloodReading,
  Capture,
  ChatSummary,
  CoachMemory,
  Manual,
  ManualAuthor,
  ManualRevision,
  ManualTrigger,
  Experiment,
  ExperimentAssignment,
  ExperimentStatus,
  ExperimentTrial,
  CoachRun,
  DayGoalAdjustment,
  EntryKind,
  EntryMessage,
  EntryNote,
  LibraryDocument,
  ProgressPhoto,
  Fast,
  FoodEntry,
  SavedMeal,
  HealthMetric,
  NotedEntryKind,
  PerformanceLog,
  PerformanceStat,
  ReadingKind,
  SleepSession,
  StateCategory,
  StateLog,
  Supplement,
  SupplementLogWithSupplement,
  Workout,
} from "./types";
import type { ChatMessage } from "./openrouter";
import type { UsageRow } from "./aiCost";
import type { ExperimentArm, ExperimentMeasure, TrialRatings } from "./schemas";
import { SETTING_KEYS } from "./types";
import { sanitizeNutrients } from "./nutrients";
import { dayOf, stampOf } from "./daystamp";
import { zone2Minutes } from "./exerciseGoals";
import { stateKey } from "./states";
import { isGlucoseUnit, isReadingKind } from "./readings";
import type { GlucoseUnit } from "./readings";
import { deletePhoto } from "./photos";
import {
  parseChatTranscript,
  parseDocumentPages,
  parseDocumentValues,
  parseEntryChanges,
  parseEntrySnapshot,
  parseExperimentArms,
  parseExperimentMeasures,
  parseJson,
  parseTrialRatings,
} from "./schemas";

const DB_URL = "sqlite:tally.db";

let sqlitePromise: Promise<Database> | null = null;

function sqlite(): Promise<Database> {
  if (!sqlitePromise) {
    sqlitePromise = Database.load(DB_URL).then(async (conn) => {
      // Photos used to be loose files in app data `photos/`; move any still
      // there into the `photos` table before anything reads one. A no-op
      // once the folder is gone; on failure the rest retry next start.
      try {
        const moved = await invoke<number>("import_photo_files");
        if (moved > 0) console.info(`Moved ${moved} photo(s) into the database`);
      } catch (e) {
        console.warn("Moving photo files into the database failed", e);
      }
      return conn;
    });
  }
  return sqlitePromise;
}

/** Warm the connection (runs pending migrations on the Rust side). */
export function getDb(): Promise<Database> {
  return sqlite();
}

/**
 * Drizzle over tauri-plugin-sql: SQL executes in the Rust process (sqlx);
 * this proxy only ships query strings + params over IPC.
 *
 * Row mapping is positional — serde_json's `preserve_order` feature is enabled
 * in src-tauri/Cargo.toml so object key order matches the SELECT column order.
 */
export const db = drizzle(async (query, params, method) => {
  const conn = await sqlite();
  if (method === "run") {
    await conn.execute(query, params);
    return { rows: [] };
  }
  const rows = (await conn.select(query, params)) as Record<string, unknown>[];
  const values = rows.map((r) => Object.values(r));
  return { rows: method === "get" ? (values[0] ?? []) : values };
});

/** Today's local date as "YYYY-MM-DD". */
export function todayStr(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function getSetting(key: string): Promise<string | null> {
  const rows = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, key));
  return rows[0]?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await db
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } });
}

export async function deleteSetting(key: string): Promise<void> {
  await db.delete(settings).where(eq(settings.key, key));
}

// ---------------------------------------------------------------------------
// Food entries
// ---------------------------------------------------------------------------

type FoodEntryRow = typeof foodEntries.$inferSelect;

function toFoodEntry(r: FoodEntryRow): FoodEntry {
  return {
    id: r.id,
    eaten_at: r.eatenAt,
    title: r.title,
    description: r.description,
    photo_path: r.photoPath,
    nutrients: sanitizeNutrients(r.nutrients),
    model_id: r.modelId,
    icon: r.icon,
    day: r.day,
    tz_offset_min: r.tzOffsetMin,
    fast_ok_note: r.fastOkNote,
  };
}

/**
 * The day and offset are stamped here rather than passed in: they are a fact
 * about the moment being logged, and every caller would otherwise have to
 * remember to derive them the same way (see lib/daystamp.ts).
 */
export async function addFoodEntry(
  entry: Omit<FoodEntry, "id" | "day" | "tz_offset_min" | "fast_ok_note"> & {
    /** Why it doesn't break a fast (see FoodEntry.fast_ok_note); omit when it does. */
    fast_ok_note?: string | null;
  },
): Promise<number> {
  const stamp = stampOf(entry.eaten_at);
  const rows = await db
    .insert(foodEntries)
    .values({
      eatenAt: entry.eaten_at,
      title: entry.title,
      description: entry.description,
      photoPath: entry.photo_path,
      nutrients: entry.nutrients,
      modelId: entry.model_id,
      icon: entry.icon,
      day: stamp.day,
      tzOffsetMin: stamp.tz_offset_min,
      fastOkNote: entry.fast_ok_note ?? null,
    })
    .returning({ id: foodEntries.id });
  return rows[0]?.id ?? 0;
}

export async function updateFoodEntry(entry: FoodEntry): Promise<void> {
  // Re-stamped from the (possibly edited) time, in the offset the entry
  // already carries — retiming a Danish dinner from the US keeps it Danish.
  const tzOffsetMin = entry.tz_offset_min;
  await db
    .update(foodEntries)
    .set({
      eatenAt: entry.eaten_at,
      title: entry.title,
      description: entry.description,
      photoPath: entry.photo_path,
      nutrients: entry.nutrients,
      modelId: entry.model_id,
      icon: entry.icon,
      day: dayOf(entry.eaten_at, tzOffsetMin),
      tzOffsetMin: tzOffsetMin ?? stampOf(entry.eaten_at).tz_offset_min,
    })
    .where(eq(foodEntries.id, entry.id));
}

/**
 * Mark one entry as not breaking a fast, with the reason. Kept apart from
 * updateFoodEntry so edits to the entry never drop the mark. Applies to this
 * entry only: whether the next one breaks a fast depends on that fast's
 * purpose, which the diary agent judges as it logs it.
 */
export async function setFoodEntryFastOk(id: number, note: string): Promise<void> {
  await db.update(foodEntries).set({ fastOkNote: note }).where(eq(foodEntries.id, id));
}

/** Make an entry count against fasts again. */
export async function clearFastOk(id: number): Promise<void> {
  await db.update(foodEntries).set({ fastOkNote: null }).where(eq(foodEntries.id, id));
}

export async function deleteFoodEntry(id: number): Promise<void> {
  await db.delete(foodEntries).where(eq(foodEntries.id, id));
  await deleteEntryMessages("meal", id);
}

export async function listFoodEntriesForDay(day: string): Promise<FoodEntry[]> {
  return listFoodEntriesForRange(day, day);
}

/** One entry by id; null when it's been deleted. */
export async function getFoodEntry(id: number): Promise<FoodEntry | null> {
  const rows = await db.select().from(foodEntries).where(eq(foodEntries.id, id)).limit(1);
  const row = rows[0];
  return row ? toFoodEntry(row) : null;
}

/**
 * ISO timestamp of the most recently eaten entry that counts as a meal for
 * fasting, or null if none. Entries marked as not breaking a fast
 * (fast_ok_note — black coffee, a supplement) never move the anchor.
 */
export async function getLastMealAt(): Promise<string | null> {
  const rows = await db
    .select({ eatenAt: foodEntries.eatenAt })
    .from(foodEntries)
    .where(isNull(foodEntries.fastOkNote))
    .orderBy(desc(foodEntries.eatenAt))
    .limit(1);
  return rows[0]?.eatenAt ?? null;
}

/**
 * Fast-breaking meals (no fast_ok_note) eaten strictly after `sinceIso`,
 * oldest first. Used to warn about meals tracked inside an active fast's
 * window — strict inequality keeps the anchor meal the fast started from out
 * of its own warning.
 */
export async function listMealsSince(sinceIso: string): Promise<FoodEntry[]> {
  const rows = await db
    .select()
    .from(foodEntries)
    .where(and(gt(foodEntries.eatenAt, sinceIso), isNull(foodEntries.fastOkNote)))
    .orderBy(foodEntries.eatenAt);
  return rows.map(toFoodEntry);
}

/** Entries from local day `startDay` through `endDay`, both inclusive. */
export async function listFoodEntriesForRange(
  startDay: string,
  endDay: string,
): Promise<FoodEntry[]> {
  const rows = await db
    .select()
    .from(foodEntries)
    .where(and(gte(foodEntries.day, startDay), lte(foodEntries.day, endDay)))
    .orderBy(desc(foodEntries.eatenAt));
  return rows.map(toFoodEntry);
}

// ---------------------------------------------------------------------------
// Workouts
// ---------------------------------------------------------------------------

type WorkoutRow = typeof workouts.$inferSelect;

function toWorkout(r: WorkoutRow): Workout {
  return {
    id: r.id,
    performed_at: r.performedAt,
    title: r.title,
    description: r.description,
    photo_path: r.photoPath,
    calories_burned: r.caloriesBurned,
    duration_min: r.durationMin,
    zone2_min: zone2Minutes(r.zone2Min, r.durationMin),
    cardio: r.cardio === 1,
    cardio_by_hand: r.cardioByHand === 1,
    model_id: r.modelId,
    icon: r.icon,
    source: r.source,
    external_id: r.externalId,
    day: r.day,
    tz_offset_min: r.tzOffsetMin,
  };
}

/** Manual/agent entries omit `source`/`external_id` — they default to null. */
export type NewWorkout = Omit<
  Workout,
  "id" | "source" | "external_id" | "day" | "tz_offset_min" | "zone2_min" | "cardio" | "cardio_by_hand"
> &
  Partial<Pick<Workout, "source" | "external_id" | "zone2_min" | "cardio">>;

export async function addWorkout(w: NewWorkout): Promise<number> {
  const stamp = stampOf(w.performed_at);
  const rows = await db
    .insert(workouts)
    .values({
      day: stamp.day,
      tzOffsetMin: stamp.tz_offset_min,
      performedAt: w.performed_at,
      title: w.title,
      description: w.description,
      photoPath: w.photo_path,
      caloriesBurned: w.calories_burned,
      durationMin: w.duration_min,
      zone2Min: zone2Minutes(w.zone2_min, w.duration_min),
      cardio: w.cardio ? 1 : 0,
      // An entry made switched on (an undo restoring one) keeps it as theirs.
      cardioByHand: w.cardio ? 1 : 0,
      modelId: w.model_id,
      icon: w.icon,
      source: w.source ?? null,
      externalId: w.external_id ?? null,
    })
    .returning({ id: workouts.id });
  return rows[0]?.id ?? 0;
}

/**
 * Insert-or-update a workout coming from an external system (Health Connect).
 * Keyed on `external_id`, so re-syncing the same window is idempotent and
 * upstream edits (e.g. corrected calories in Garmin) flow through.
 */
export async function upsertExternalWorkout(
  w: Omit<Workout, "id" | "day" | "tz_offset_min" | "zone2_min" | "cardio" | "cardio_by_hand"> & {
    zone2_min?: number | null;
    external_id: string;
    /** Offset the source recorded it in; falls back to here. */
    tz_offset_min?: number | null;
    /** The writing app's own id for the record (Health Connect clientRecordId). */
    source_record_id?: string | null;
  },
): Promise<void> {
  // Health Connect carries the offset the session was recorded in, so a run
  // synced a week later from another continent keeps the day it was run on.
  const tzOffsetMin = w.tz_offset_min ?? stampOf(w.performed_at).tz_offset_min;
  const day = dayOf(w.performed_at, tzOffsetMin);
  await db
    .insert(workouts)
    .values({
      day,
      tzOffsetMin,
      performedAt: w.performed_at,
      title: w.title,
      description: w.description,
      photoPath: w.photo_path,
      caloriesBurned: w.calories_burned,
      durationMin: w.duration_min,
      zone2Min: zone2Minutes(w.zone2_min, w.duration_min),
      modelId: w.model_id,
      icon: w.icon,
      source: w.source,
      externalId: w.external_id,
      sourceRecordId: w.source_record_id ?? null,
    })
    .onConflictDoUpdate({
      target: workouts.externalId,
      set: {
        // Only re-stamp when the source itself carries the zone: otherwise a
        // re-sync run abroad would drag an old session onto a foreign day.
        ...(w.tz_offset_min != null ? { day, tzOffsetMin } : {}),
        performedAt: w.performed_at,
        title: w.title,
        description: w.description,
        caloriesBurned: w.calories_burned,
        durationMin: w.duration_min,
        // Whole-session marks follow a corrected duration; explicit off and
        // partial Zone 2 minutes survive a re-sync unchanged.
        zone2Min: sql`case when ${workouts.zone2Min} > 0
          and ${workouts.zone2Min} = ${workouts.durationMin}
          and ${w.duration_min} > 0 then ${w.duration_min}
          else ${workouts.zone2Min} end`,
        source: w.source,
        sourceRecordId: w.source_record_id ?? null,
      },
    });
}

export async function updateWorkout(w: Workout): Promise<void> {
  await db
    .update(workouts)
    .set({
      day: dayOf(w.performed_at, w.tz_offset_min),
      performedAt: w.performed_at,
      title: w.title,
      description: w.description,
      photoPath: w.photo_path,
      caloriesBurned: w.calories_burned,
      durationMin: w.duration_min,
      zone2Min: zone2Minutes(w.zone2_min, w.duration_min),
      // cardio is left out on purpose: only the switch sets it
      // (setWorkoutCardio), so an edit or an undo can't flip it.
      modelId: w.model_id,
      icon: w.icon,
    })
    .where(eq(workouts.id, w.id));
}

/**
 * The per-workout cardio switch. A synced re-import leaves it alone, and once
 * flipped by hand so does the Zone 2 rule (applyZone2Cardio).
 */
export async function setWorkoutCardio(id: number, cardio: boolean): Promise<void> {
  await db.update(workouts).set({ cardio: cardio ? 1 : 0, cardioByHand: 1 }).where(eq(workouts.id, id));
}

/** A deliberate toggle wins over text recognition, including an explicit off (0). */
export async function setWorkoutZone2(id: number, enabled: boolean): Promise<void> {
  const rows = await db.update(workouts)
    .set({ zone2Min: enabled ? sql`${workouts.durationMin}` : 0 })
    .where(enabled ? and(eq(workouts.id, id), gt(workouts.durationMin, 0)) : eq(workouts.id, id))
    .returning({ id: workouts.id });
  if (rows.length === 0) throw new Error("The workout needs a duration before it can count as Zone 2, or it no longer exists.");
}

/** One workout by id; null when it's been deleted. */
export async function getWorkout(id: number): Promise<Workout | null> {
  const rows = await db.select().from(workouts).where(eq(workouts.id, id)).limit(1);
  const row = rows[0];
  return row ? toWorkout(row) : null;
}

export async function deleteWorkout(id: number): Promise<void> {
  await db.delete(workouts).where(eq(workouts.id, id));
  await deleteEntryMessages("workout", id);
  // A Garmin activity whose workout was deleted stays known, so the Garmin
  // Connect sync doesn't put it back (see lib/garmin.ts).
  await db
    .update(garminActivities)
    .set({ workoutId: null, dismissed: 1 })
    .where(eq(garminActivities.workoutId, id));
}

export async function listWorkoutsForDay(day: string): Promise<Workout[]> {
  return listWorkoutsForRange(day, day);
}

/**
 * Drop what Health Connect sync wrote that didn't come from `keepSource` —
 * workouts and nights from other apps, and every day of metrics from
 * `fromDay` on (the caller re-reads those right after). Hand-logged workouts
 * are never touched, and neither is anything the Garmin Connect sync created
 * or linked: it isn't Health Connect's to purge.
 */
export async function purgeSyncedDataNotFrom(
  keepSource: string,
  fromDay: string,
): Promise<void> {
  const stale = await db
    .select({ id: workouts.id })
    .from(workouts)
    .where(
      and(
        isNotNull(workouts.externalId),
        sql`${workouts.source} IS NOT ${keepSource}`,
        sql`${workouts.externalId} NOT LIKE 'garmin:%'`,
        sql`NOT EXISTS (SELECT 1 FROM ${garminActivities} WHERE ${garminActivities.workoutId} = ${workouts.id})`,
      ),
    );
  for (const w of stale) await deleteWorkout(w.id);
  await db
    .delete(sleepSessions)
    .where(
      and(
        sql`${sleepSessions.source} IS NOT ${keepSource}`,
        sql`${sleepSessions.externalId} NOT LIKE 'garmin-sleep:%'`,
      ),
    );
  await db.delete(healthMetrics).where(gte(healthMetrics.day, fromDay));
}

/** Every workout synced from an external source (Garmin etc.), newest first. */
export async function listSyncedWorkouts(): Promise<Workout[]> {
  const rows = await db
    .select()
    .from(workouts)
    .where(isNotNull(workouts.source))
    .orderBy(desc(workouts.performedAt));
  return rows.map(toWorkout);
}

/** Workouts from local day `startDay` through `endDay`, both inclusive. */
export async function listWorkoutsForRange(
  startDay: string,
  endDay: string,
): Promise<Workout[]> {
  const rows = await db
    .select()
    .from(workouts)
    .where(and(gte(workouts.day, startDay), lte(workouts.day, endDay)))
    .orderBy(desc(workouts.performedAt));
  return rows.map(toWorkout);
}

// ---------------------------------------------------------------------------
// Sleep sessions (synced from Health Connect)
// ---------------------------------------------------------------------------

type SleepRow = typeof sleepSessions.$inferSelect;

function toSleepSession(r: SleepRow): SleepSession {
  return {
    id: r.id,
    external_id: r.externalId,
    started_at: r.startedAt,
    ended_at: r.endedAt,
    duration_min: r.durationMin,
    deep_min: r.deepMin,
    rem_min: r.remMin,
    light_min: r.lightMin,
    awake_min: r.awakeMin,
    source: r.source,
    day: r.day,
    tz_offset_min: r.tzOffsetMin,
  };
}

/** Insert-or-update a sleep session, keyed on its Health Connect UID. */
export async function upsertSleepSession(
  s: Omit<SleepSession, "id" | "day" | "tz_offset_min"> & {
    /** Offset the night was slept in; falls back to here. */
    tz_offset_min?: number | null;
    /** The writing app's own id for the record (Health Connect clientRecordId). */
    source_record_id?: string | null;
  },
): Promise<void> {
  // Filed under the morning it ended, in the zone it was slept in.
  const tzOffsetMin = s.tz_offset_min ?? stampOf(s.ended_at).tz_offset_min;
  const stamp = { day: dayOf(s.ended_at, tzOffsetMin), tzOffsetMin };
  const values = {
    ...stamp,
    externalId: s.external_id,
    startedAt: s.started_at,
    endedAt: s.ended_at,
    durationMin: s.duration_min,
    deepMin: s.deep_min,
    remMin: s.rem_min,
    lightMin: s.light_min,
    awakeMin: s.awake_min,
    source: s.source,
    sourceRecordId: s.source_record_id ?? null,
  };
  // As above: a night keeps the day it was slept on unless the source tells us
  // which zone that was, so a re-sync run abroad can't move it.
  const { day: _day, tzOffsetMin: _tz, ...withoutStamp } = values;
  await db
    .insert(sleepSessions)
    .values(values)
    .onConflictDoUpdate({
      target: sleepSessions.externalId,
      set: s.tz_offset_min != null ? values : withoutStamp,
    });
}

/** Every sleep session ever synced, newest first. */
export async function listAllSleepSessions(): Promise<SleepSession[]> {
  const rows = await db
    .select()
    .from(sleepSessions)
    .orderBy(desc(sleepSessions.startedAt));
  return rows.map(toSleepSession);
}

/** One night by id; null when it's gone. */
export async function getSleepSession(id: number): Promise<SleepSession | null> {
  const rows = await db.select().from(sleepSessions).where(eq(sleepSessions.id, id)).limit(1);
  const row = rows[0];
  return row ? toSleepSession(row) : null;
}

/**
 * Sleep sessions that END within the local-day range — a night that starts
 * before midnight belongs to the morning it finished.
 */
export async function listSleepForRange(
  startDay: string,
  endDay: string,
): Promise<SleepSession[]> {
  const rows = await db
    .select()
    .from(sleepSessions)
    .where(and(gte(sleepSessions.day, startDay), lte(sleepSessions.day, endDay)))
    .orderBy(desc(sleepSessions.startedAt));
  return rows.map(toSleepSession);
}

// ---------------------------------------------------------------------------
// Daily health metrics (synced from Health Connect)
// ---------------------------------------------------------------------------

type HealthMetricRow = typeof healthMetrics.$inferSelect;

function toHealthMetric(r: HealthMetricRow): HealthMetric {
  return {
    day: r.day,
    steps: r.steps,
    resting_hr: r.restingHr,
    hrv_ms: r.hrvMs,
    spo2_pct: r.spo2Pct,
    weight_kg: r.weightKg,
    vo2_max: r.vo2Max,
    calories_total: r.caloriesTotal,
    updated_at: r.updatedAt,
  };
}

/** Insert-or-update one day of metrics; only non-null fields overwrite. */
export async function upsertHealthMetric(
  m: Omit<HealthMetric, "updated_at">,
): Promise<void> {
  const updatedAt = new Date().toISOString();
  const values = {
    day: m.day,
    steps: m.steps,
    restingHr: m.resting_hr,
    hrvMs: m.hrv_ms,
    spo2Pct: m.spo2_pct,
    weightKg: m.weight_kg,
    vo2Max: m.vo2_max,
    caloriesTotal: m.calories_total,
    updatedAt,
  };
  // COALESCE keeps an existing value when a re-sync window happens to carry
  // no records of that type for the day.
  await db
    .insert(healthMetrics)
    .values(values)
    .onConflictDoUpdate({
      target: healthMetrics.day,
      set: {
        steps: sql`COALESCE(${m.steps ?? null}, ${healthMetrics.steps})`,
        restingHr: sql`COALESCE(${m.resting_hr ?? null}, ${healthMetrics.restingHr})`,
        hrvMs: sql`COALESCE(${m.hrv_ms ?? null}, ${healthMetrics.hrvMs})`,
        spo2Pct: sql`COALESCE(${m.spo2_pct ?? null}, ${healthMetrics.spo2Pct})`,
        weightKg: sql`COALESCE(${m.weight_kg ?? null}, ${healthMetrics.weightKg})`,
        vo2Max: sql`COALESCE(${m.vo2_max ?? null}, ${healthMetrics.vo2Max})`,
        caloriesTotal: sql`COALESCE(${m.calories_total ?? null}, ${healthMetrics.caloriesTotal})`,
        updatedAt,
      },
    });
}

/** Every day of synced metrics, newest first. */
export async function listAllHealthMetrics(): Promise<HealthMetric[]> {
  const rows = await db
    .select()
    .from(healthMetrics)
    .orderBy(desc(healthMetrics.day));
  return rows.map(toHealthMetric);
}

/** The most recent weight on record (kg), or null when none has been synced. */
export async function getLatestWeightKg(): Promise<number | null> {
  const rows = await db
    .select({ w: healthMetrics.weightKg })
    .from(healthMetrics)
    .where(isNotNull(healthMetrics.weightKg))
    .orderBy(desc(healthMetrics.day))
    .limit(1);
  const w = rows[0]?.w;
  return typeof w === "number" && w > 20 && w < 400 ? w : null;
}

/** Metrics from local day `startDay` through `endDay`, both inclusive. */
export async function listHealthMetricsForRange(
  startDay: string,
  endDay: string,
): Promise<HealthMetric[]> {
  const rows = await db
    .select()
    .from(healthMetrics)
    .where(and(gte(healthMetrics.day, startDay), lte(healthMetrics.day, endDay)))
    .orderBy(desc(healthMetrics.day));
  return rows.map(toHealthMetric);
}

// ---------------------------------------------------------------------------
// Captures (fire-and-forget agent inbox)
// ---------------------------------------------------------------------------

type CaptureRow = typeof captures.$inferSelect;

function toCapture(r: CaptureRow): Capture {
  return {
    id: r.id,
    created_at: r.createdAt,
    day: r.day,
    note: r.note,
    photo_path: r.photoPath,
    status: r.status === "error" ? "error" : "pending",
    error: r.error,
  };
}

export async function addCapture(
  c: Omit<Capture, "id" | "status" | "error">,
): Promise<number> {
  const rows = await db
    .insert(captures)
    .values({
      createdAt: c.created_at,
      day: c.day,
      note: c.note,
      photoPath: c.photo_path,
      status: "pending",
      error: null,
    })
    .returning({ id: captures.id });
  return rows[0]?.id ?? 0;
}

export async function listCapturesForDay(day: string): Promise<Capture[]> {
  const rows = await db
    .select()
    .from(captures)
    .where(eq(captures.day, day))
    .orderBy(desc(captures.createdAt));
  return rows.map(toCapture);
}

export async function listPendingCaptures(): Promise<Capture[]> {
  const rows = await db.select().from(captures).where(eq(captures.status, "pending"));
  return rows.map(toCapture);
}

export async function getCapture(id: number): Promise<Capture | null> {
  const rows = await db.select().from(captures).where(eq(captures.id, id)).limit(1);
  const row = rows[0];
  return row ? toCapture(row) : null;
}

export async function setCaptureStatus(
  id: number,
  status: "pending" | "error",
  error: string | null,
): Promise<void> {
  await db.update(captures).set({ status, error }).where(eq(captures.id, id));
}

export async function deleteCapture(id: number): Promise<void> {
  await db.delete(captures).where(eq(captures.id, id));
}

// ---------------------------------------------------------------------------
// Stored photos (shared by filename across rows)
// ---------------------------------------------------------------------------
//
// A photo is stored once (a row in `photos`) and referenced by filename. When a
// capture resolves into an entry, that filename is passed THROUGH to the
// food/workout entry (see agent.ts) — so the same photo is pointed at by the
// capture and the entry it produced, and can outlive either one. Deleting the
// photo whenever a single referrer goes away is what orphaned surviving entries'
// images (a discarded capture taking its already-logged meal's photo with it).

/**
 * Does any capture, entry, reading, document, performance log or progress
 * photo still reference this photo?
 * Callers delete the owning row FIRST, then ask — so a file shared only with
 * the just-deleted row reads as unreferenced.
 */
export async function isPhotoReferenced(filename: string): Promise<boolean> {
  const [inFood, inWorkouts, inCaptures, inDocuments, inReadings, inPerformance, inProgress] = await Promise.all([
    db.select({ id: foodEntries.id }).from(foodEntries).where(eq(foodEntries.photoPath, filename)).limit(1),
    db.select({ id: workouts.id }).from(workouts).where(eq(workouts.photoPath, filename)).limit(1),
    db.select({ id: captures.id }).from(captures).where(eq(captures.photoPath, filename)).limit(1),
    db.select({ id: documents.id }).from(documents).where(eq(documents.photoPath, filename)).limit(1),
    db.select({ id: bloodReadings.id }).from(bloodReadings).where(eq(bloodReadings.photoPath, filename)).limit(1),
    db.select({ id: performanceLogs.id }).from(performanceLogs).where(eq(performanceLogs.photoPath, filename)).limit(1),
    db.select({ id: progressPhotos.id }).from(progressPhotos).where(eq(progressPhotos.photoPath, filename)).limit(1),
  ]);
  return (
    inFood.length > 0 ||
    inWorkouts.length > 0 ||
    inCaptures.length > 0 ||
    inDocuments.length > 0 ||
    inReadings.length > 0 ||
    inPerformance.length > 0 ||
    inProgress.length > 0
  );
}

// ---------------------------------------------------------------------------
// Progress photos (see `progressPhotos` in db/schema.ts)
// ---------------------------------------------------------------------------

/** Every progress photo, newest first. */
export async function listProgressPhotos(): Promise<ProgressPhoto[]> {
  const rows = await db.select().from(progressPhotos).orderBy(desc(progressPhotos.takenAt));
  return rows.map((r) => ({
    id: r.id,
    taken_at: r.takenAt,
    day: r.day,
    tz_offset_min: r.tzOffsetMin,
    photo_path: r.photoPath,
  }));
}

/** Store a progress photo already saved with `savePhoto`. */
export async function addProgressPhoto(photoPath: string, takenAt: string): Promise<void> {
  const stamp = stampOf(takenAt);
  await db.insert(progressPhotos).values({
    takenAt,
    day: stamp.day,
    tzOffsetMin: stamp.tz_offset_min,
    photoPath,
  });
}

/** Remove a progress photo, and its image unless something else uses it. */
export async function deleteProgressPhoto(photo: ProgressPhoto): Promise<void> {
  await db.delete(progressPhotos).where(eq(progressPhotos.id, photo.id));
  await deletePhotoIfUnused(photo.photo_path);
}

/**
 * Delete a stored photo only when no diary row still points at it.
 * This is the safe replacement for a bare `deletePhoto` after removing a row:
 * delete the row first, then call this so a photo another entry still uses is
 * preserved. A no-op for a null/empty filename.
 */
export async function deletePhotoIfUnused(
  filename: string | null | undefined,
): Promise<void> {
  if (!filename) return;
  if (await isPhotoReferenced(filename)) return;
  await deletePhoto(filename);
}

// ---------------------------------------------------------------------------
// Supplements
// ---------------------------------------------------------------------------

type SupplementRow = typeof supplements.$inferSelect;

function toSupplement(r: SupplementRow): Supplement {
  return {
    id: r.id,
    name: r.name,
    dose_amount: r.doseAmount,
    dose_unit: r.doseUnit,
    nutrients: sanitizeNutrients(r.nutrients),
    notes: r.notes,
    archived: r.archived,
  };
}

export async function listSupplements(includeArchived = false): Promise<Supplement[]> {
  const rows = await db
    .select()
    .from(supplements)
    .where(includeArchived ? undefined : eq(supplements.archived, 0))
    .orderBy(supplements.archived, sql`${supplements.name} COLLATE NOCASE`);
  return rows.map(toSupplement);
}

// ---------------------------------------------------------------------------
// Supplement logs
// ---------------------------------------------------------------------------

export async function updateSupplementLog(
  id: number,
  amount: number,
  takenAt: string,
  tzOffsetMin?: number | null,
): Promise<void> {
  await db
    .update(supplementLogs)
    .set({
      amount,
      takenAt,
      day: dayOf(takenAt, tzOffsetMin),
      tzOffsetMin: tzOffsetMin ?? stampOf(takenAt).tz_offset_min,
    })
    .where(eq(supplementLogs.id, id));
}

/** One supplement dose by id, joined with its supplement; null when gone. */
export async function getSupplementLog(
  id: number,
): Promise<SupplementLogWithSupplement | null> {
  const rows = await db
    .select({
      id: supplementLogs.id,
      supplement_id: supplementLogs.supplementId,
      taken_at: supplementLogs.takenAt,
      amount: supplementLogs.amount,
      day: supplementLogs.day,
      tz_offset_min: supplementLogs.tzOffsetMin,
      name: supplements.name,
      dose_amount: supplements.doseAmount,
      dose_unit: supplements.doseUnit,
      nutrients: supplements.nutrients,
    })
    .from(supplementLogs)
    .innerJoin(supplements, eq(supplements.id, supplementLogs.supplementId))
    .where(eq(supplementLogs.id, id))
    .limit(1);
  const r = rows[0];
  return r ? { ...r, nutrients: sanitizeNutrients(r.nutrients) } : null;
}

export async function deleteSupplementLog(id: number): Promise<void> {
  await db.delete(supplementLogs).where(eq(supplementLogs.id, id));
}

/**
 * Turn one old supplement log into a diary entry (supplements are food now).
 * The entry keeps the log's own day and offset — it happened where it
 * happened — and the log is removed only once the entry exists, so a crash in
 * between can at worst leave both, never neither.
 */
export async function convertSupplementLogToFood(
  logId: number,
  entry: Omit<FoodEntry, "id" | "photo_path" | "fast_ok_note">,
): Promise<void> {
  await db.insert(foodEntries).values({
    eatenAt: entry.eaten_at,
    title: entry.title,
    description: entry.description,
    photoPath: null,
    nutrients: entry.nutrients,
    modelId: entry.model_id,
    icon: entry.icon,
    day: entry.day ?? stampOf(entry.eaten_at).day,
    tzOffsetMin: entry.tz_offset_min ?? stampOf(entry.eaten_at).tz_offset_min,
    // Logged before the diary agent judged fasts: keep the old rule, where
    // anything under 20 kcal never broke one.
    fastOkNote: (entry.nutrients.calories ?? Infinity) < 20 ? "Under 20 kcal" : null,
  });
  await db.delete(supplementLogs).where(eq(supplementLogs.id, logId));
}

export async function listSupplementLogsForDay(
  day: string,
): Promise<SupplementLogWithSupplement[]> {
  return listSupplementLogsForRange(day, day);
}

/** Supplement logs from local day `startDay` through `endDay`, both inclusive. */
export async function listSupplementLogsForRange(
  startDay: string,
  endDay: string,
): Promise<SupplementLogWithSupplement[]> {
  // Field names are unique across the two tables — required, since the
  // proxy's positional mapping collapses duplicate column names.
  const rows = await db
    .select({
      id: supplementLogs.id,
      supplement_id: supplementLogs.supplementId,
      taken_at: supplementLogs.takenAt,
      amount: supplementLogs.amount,
      day: supplementLogs.day,
      tz_offset_min: supplementLogs.tzOffsetMin,
      name: supplements.name,
      dose_amount: supplements.doseAmount,
      dose_unit: supplements.doseUnit,
      nutrients: supplements.nutrients,
    })
    .from(supplementLogs)
    .innerJoin(supplements, eq(supplements.id, supplementLogs.supplementId))
    .where(and(gte(supplementLogs.day, startDay), lte(supplementLogs.day, endDay)))
    .orderBy(desc(supplementLogs.takenAt));
  return rows.map((r) => ({ ...r, nutrients: sanitizeNutrients(r.nutrients) }));
}

// ---------------------------------------------------------------------------
// Assistant chats
// ---------------------------------------------------------------------------

export async function listChats(limit = 50): Promise<ChatSummary[]> {
  const rows = await db
    .select({
      id: chats.id,
      title: chats.title,
      createdAt: chats.createdAt,
      updatedAt: chats.updatedAt,
    })
    .from(chats)
    .orderBy(desc(chats.updatedAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  }));
}

/** One chat's heading, without its transcript; null when it's gone. */
export async function getChatSummary(id: number): Promise<ChatSummary | null> {
  const rows = await db
    .select({
      id: chats.id,
      title: chats.title,
      createdAt: chats.createdAt,
      updatedAt: chats.updatedAt,
    })
    .from(chats)
    .where(eq(chats.id, id))
    .limit(1);
  const r = rows[0];
  return r
    ? { id: r.id, title: r.title, created_at: r.createdAt, updated_at: r.updatedAt }
    : null;
}

/** Full transcript of a saved chat; null when the chat doesn't exist. */
export async function getChatMessages(id: number): Promise<ChatMessage[] | null> {
  const rows = await db
    .select({ messages: chats.messages })
    .from(chats)
    .where(eq(chats.id, id))
    .limit(1);
  const raw: unknown = rows[0]?.messages;
  if (raw === undefined) return null;
  const parsed = typeof raw === "string" ? parseJson(raw) : raw;
  return parseChatTranscript(parsed);
}

export async function createChat(
  title: string,
  messages: ChatMessage[],
): Promise<number> {
  const now = new Date().toISOString();
  const rows = await db
    .insert(chats)
    .values({ createdAt: now, updatedAt: now, title, messages })
    .returning({ id: chats.id });
  return rows[0]?.id ?? 0;
}

export async function updateChatMessages(
  id: number,
  messages: ChatMessage[],
): Promise<void> {
  await db
    .update(chats)
    .set({ messages, updatedAt: new Date().toISOString() })
    .where(eq(chats.id, id));
}

export async function deleteChat(id: number): Promise<void> {
  await db.delete(chats).where(eq(chats.id, id));
}

// ---------------------------------------------------------------------------
// AI spend (the `ai_usage` ledger)
// ---------------------------------------------------------------------------

export interface AiUsageRecord {
  /** The feature that spent it (an AiFeature, see lib/aiCost.ts). */
  source: string;
  chatId: number | null;
  model: string;
  requests: number;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  costUsd: number;
}

/** Log what one or more requests cost. Skips records of no requests. */
export async function recordAiUsage(r: AiUsageRecord): Promise<void> {
  if (r.requests === 0) return;
  await db.insert(aiUsage).values({
    createdAt: new Date().toISOString(),
    day: todayStr(),
    source: r.source,
    chatId: r.chatId,
    model: r.model,
    requests: r.requests,
    promptTokens: r.promptTokens,
    cachedTokens: r.cachedTokens,
    completionTokens: r.completionTokens,
    costUsd: r.costUsd,
  });
}

export interface AiSpend {
  costUsd: number;
  requests: number;
  promptTokens: number;
  cachedTokens: number;
}

/** Spend from `sinceDay` (local, inclusive) on, optionally for one source. */
export async function aiSpendSince(
  sinceDay: string,
  source?: string,
): Promise<AiSpend> {
  const rows = await db
    .select({
      costUsd: sql<number>`coalesce(sum(${aiUsage.costUsd}), 0)`,
      requests: sql<number>`coalesce(sum(${aiUsage.requests}), 0)`,
      promptTokens: sql<number>`coalesce(sum(${aiUsage.promptTokens}), 0)`,
      cachedTokens: sql<number>`coalesce(sum(${aiUsage.cachedTokens}), 0)`,
    })
    .from(aiUsage)
    .where(
      source
        ? and(gte(aiUsage.day, sinceDay), eq(aiUsage.source, source))
        : gte(aiUsage.day, sinceDay),
    );
  const r = rows[0];
  return {
    costUsd: Number(r?.costUsd ?? 0),
    requests: Number(r?.requests ?? 0),
    promptTokens: Number(r?.promptTokens ?? 0),
    cachedTokens: Number(r?.cachedTokens ?? 0),
  };
}

/**
 * The ledger from `sinceDay` (local, inclusive) on, summed per day, feature
 * and model: everything the cost center shows, in one read.
 */
export async function listAiUsageSince(sinceDay: string): Promise<UsageRow[]> {
  const rows = await db
    .select({
      day: aiUsage.day,
      source: aiUsage.source,
      model: aiUsage.model,
      requests: sql<number>`sum(${aiUsage.requests})`,
      promptTokens: sql<number>`sum(${aiUsage.promptTokens})`,
      cachedTokens: sql<number>`sum(${aiUsage.cachedTokens})`,
      completionTokens: sql<number>`sum(${aiUsage.completionTokens})`,
      costUsd: sql<number>`sum(${aiUsage.costUsd})`,
    })
    .from(aiUsage)
    .where(gte(aiUsage.day, sinceDay))
    .groupBy(aiUsage.day, aiUsage.source, aiUsage.model);
  return rows.map((r) => ({
    day: r.day,
    source: r.source,
    model: r.model,
    requests: Number(r.requests),
    promptTokens: Number(r.promptTokens),
    cachedTokens: Number(r.cachedTokens),
    completionTokens: Number(r.completionTokens),
    costUsd: Number(r.costUsd),
  }));
}

/** The first day anything was logged, or null when the ledger is empty. */
export async function firstAiUsageDay(): Promise<string | null> {
  const rows = await db.select({ day: sql<string | null>`min(${aiUsage.day})` }).from(aiUsage);
  return rows[0]?.day ?? null;
}

// ---------------------------------------------------------------------------
// Fasts
// ---------------------------------------------------------------------------

type FastRow = typeof fasts.$inferSelect;

function toFast(r: FastRow): Fast {
  return {
    id: r.id,
    started_at: r.startedAt,
    goal_hours: r.goalHours,
    purpose: r.purpose,
    ended_at: r.endedAt,
    start_day: r.startDay,
    end_day: r.endDay,
    tz_offset_min: r.tzOffsetMin,
  };
}

export async function getActiveFast(): Promise<Fast | null> {
  const rows = await db
    .select()
    .from(fasts)
    .where(isNull(fasts.endedAt))
    .orderBy(desc(fasts.startedAt))
    .limit(1);
  const row = rows[0];
  return row ? toFast(row) : null;
}

export async function insertFast(
  goalHours: number,
  startedAt: string,
  purpose: string | null,
): Promise<Fast> {
  const stamp = stampOf(startedAt);
  const rows = await db
    .insert(fasts)
    .values({
      startedAt,
      goalHours,
      purpose,
      endedAt: null,
      startDay: stamp.day,
      tzOffsetMin: stamp.tz_offset_min,
    })
    .returning({ id: fasts.id });
  return {
    id: rows[0]?.id ?? 0,
    started_at: startedAt,
    goal_hours: goalHours,
    purpose,
    ended_at: null,
    start_day: stamp.day,
    end_day: null,
    tz_offset_min: stamp.tz_offset_min,
  };
}

/**
 * Set or change what a fast is for — free to change mid-fast: it's what the
 * diary agent judges the next entries against, not a commitment.
 */
export async function setFastPurpose(id: number, purpose: string | null): Promise<void> {
  await db.update(fasts).set({ purpose }).where(eq(fasts.id, id));
}

/** A fast is stamped at both ends: it can be broken in another timezone. */
export async function markFastEnded(id: number, endedAt: string): Promise<void> {
  await db
    .update(fasts)
    .set({ endedAt, endDay: stampOf(endedAt).day })
    .where(eq(fasts.id, id));
}

export async function listRecentFasts(limit = 20): Promise<Fast[]> {
  const rows = await db
    .select()
    .from(fasts)
    .where(isNotNull(fasts.endedAt))
    .orderBy(desc(fasts.startedAt))
    .limit(limit);
  return rows.map(toFast);
}

export async function deleteFast(id: number): Promise<void> {
  // A fast that never happened can't have been a trial either.
  await db.delete(experimentTrials).where(eq(experimentTrials.fastId, id));
  await db.delete(fasts).where(eq(fasts.id, id));
}

/** Every fast ever recorded (active one included), oldest first. */
export async function listAllFasts(): Promise<Fast[]> {
  const rows = await db.select().from(fasts).orderBy(fasts.startedAt);
  return rows.map(toFast);
}

// ---------------------------------------------------------------------------
// Document library
// ---------------------------------------------------------------------------

type DocumentRow = typeof documents.$inferSelect;

function toDocument(r: DocumentRow): LibraryDocument {
  const kinds = ["lab", "imaging", "report", "note", "other"] as const;
  const kind = (kinds as readonly string[]).includes(r.kind)
    ? (r.kind as LibraryDocument["kind"])
    : "other";
  const status =
    r.status === "pending" || r.status === "error" ? r.status : "ready";
  return {
    id: r.id,
    created_at: r.createdAt,
    document_date: r.documentDate,
    title: r.title,
    kind,
    photo_path: r.photoPath,
    page_paths: parseDocumentPages(r.pagePaths),
    note: r.note,
    summary: r.summary,
    extracted: parseDocumentValues(r.extracted),
    status,
    error: r.error,
    model_id: r.modelId,
  };
}

/**
 * The library, newest first by the date the document refers to. Ones still
 * being read have no date yet, so they're ordered by arrival and sort to the
 * top — which is where a just-added document belongs anyway.
 */
export async function listDocuments(): Promise<LibraryDocument[]> {
  const rows = await db
    .select()
    .from(documents)
    .orderBy(desc(documents.documentDate), desc(documents.createdAt));
  return rows.map(toDocument);
}

/** Documents referring to local days `startDay`..`endDay`, inclusive. */
export async function listDocumentsForRange(
  startDay: string,
  endDay: string,
): Promise<LibraryDocument[]> {
  const rows = await db
    .select()
    .from(documents)
    .where(
      and(gte(documents.documentDate, startDay), lte(documents.documentDate, endDay)),
    )
    .orderBy(desc(documents.documentDate));
  return rows.map(toDocument);
}

export async function getDocument(id: number): Promise<LibraryDocument | null> {
  const rows = await db.select().from(documents).where(eq(documents.id, id));
  const row = rows[0];
  return row ? toDocument(row) : null;
}

export async function addDocument(d: {
  title: string;
  note: string | null;
  /** Pages in order; the first doubles as the document's `photo_path`. */
  page_paths: string[];
}): Promise<number> {
  const rows = await db
    .insert(documents)
    .values({
      createdAt: new Date().toISOString(),
      title: d.title,
      note: d.note,
      photoPath: d.page_paths[0] ?? null,
      pagePaths: d.page_paths,
    })
    .returning({ id: documents.id });
  return rows[0]?.id ?? 0;
}

/** Patch a document; absent fields are left alone. */
export async function updateDocument(
  id: number,
  patch: Partial<
    Pick<
      LibraryDocument,
      | "title"
      | "kind"
      | "document_date"
      | "summary"
      | "extracted"
      | "status"
      | "error"
      | "model_id"
      | "note"
    >
  >,
): Promise<void> {
  const set: Record<string, unknown> = {};
  if (patch.title !== undefined) set["title"] = patch.title;
  if (patch.kind !== undefined) set["kind"] = patch.kind;
  if (patch.document_date !== undefined) set["documentDate"] = patch.document_date;
  if (patch.summary !== undefined) set["summary"] = patch.summary;
  if (patch.extracted !== undefined) set["extracted"] = patch.extracted;
  if (patch.status !== undefined) set["status"] = patch.status;
  if (patch.error !== undefined) set["error"] = patch.error;
  if (patch.model_id !== undefined) set["modelId"] = patch.model_id;
  if (patch.note !== undefined) set["note"] = patch.note;
  if (Object.keys(set).length === 0) return;
  await db.update(documents).set(set).where(eq(documents.id, id));
}

export async function deleteDocument(id: number): Promise<void> {
  await db.delete(documents).where(eq(documents.id, id));
}

/** Documents whose reading was interrupted, so it can be picked up again. */
export async function listPendingDocuments(): Promise<LibraryDocument[]> {
  const rows = await db
    .select()
    .from(documents)
    .where(eq(documents.status, "pending"))
    .orderBy(documents.createdAt);
  return rows.map(toDocument);
}

// ---------------------------------------------------------------------------
// Coach memory
// ---------------------------------------------------------------------------

type CoachMemoryRow = typeof coachMemory.$inferSelect;

function toCoachMemory(r: CoachMemoryRow): CoachMemory {
  const kind =
    r.kind === "goal" || r.kind === "commitment" || r.kind === "preference"
      ? r.kind
      : "note";
  const status =
    r.status === "open" || r.status === "done" || r.status === "dropped"
      ? r.status
      : null;
  return {
    id: r.id,
    kind,
    text: r.text,
    status,
    follow_up_on: r.followUpOn,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  };
}

/** Everything the coach knows, oldest first so goals read before later notes. */
export async function listCoachMemory(): Promise<CoachMemory[]> {
  const rows = await db.select().from(coachMemory).orderBy(coachMemory.id);
  return rows.map(toCoachMemory);
}

export async function addCoachMemory(
  kind: CoachMemory["kind"],
  text: string,
  status: CoachMemory["status"] = null,
  followUpOn: string | null = null,
): Promise<number> {
  const now = new Date().toISOString();
  const rows = await db
    .insert(coachMemory)
    .values({ kind, text, status, followUpOn, createdAt: now, updatedAt: now })
    .returning({ id: coachMemory.id });
  return rows[0]?.id ?? 0;
}

/** Patch one row; absent fields are left alone. Returns false if it's gone. */
export async function updateCoachMemory(
  id: number,
  patch: {
    text?: string;
    status?: CoachMemory["status"];
    /** null clears the reminder; a day string sets or moves it. */
    followUpOn?: string | null;
  },
): Promise<boolean> {
  const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (patch.text !== undefined) set["text"] = patch.text;
  if (patch.status !== undefined) set["status"] = patch.status;
  if (patch.followUpOn !== undefined) set["followUpOn"] = patch.followUpOn;
  const rows = await db
    .update(coachMemory)
    .set(set)
    .where(eq(coachMemory.id, id))
    .returning({ id: coachMemory.id });
  return rows.length > 0;
}

export async function deleteCoachMemory(id: number): Promise<void> {
  await db.delete(coachMemory).where(eq(coachMemory.id, id));
}

/** Memories whose reminder has come due on or before `day`. */
export async function listDueFollowUps(day: string): Promise<CoachMemory[]> {
  const rows = await db
    .select()
    .from(coachMemory)
    .where(and(isNotNull(coachMemory.followUpOn), lte(coachMemory.followUpOn, day)))
    .orderBy(coachMemory.followUpOn);
  return rows.map(toCoachMemory);
}

/**
 * Take the reminder off these memories. Called the moment a follow-up is
 * raised: a reminder fires once, and the coach re-arms it if the thing still
 * needs watching. Without this a follow-up the coach forgot to close would
 * come back every day and crowd out everything else.
 */
export async function clearFollowUps(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  const now = new Date().toISOString();
  for (const id of ids) {
    await db
      .update(coachMemory)
      .set({ followUpOn: null, updatedAt: now })
      .where(eq(coachMemory.id, id));
  }
}

// ---------------------------------------------------------------------------
// Manuals
// ---------------------------------------------------------------------------

type ManualRow = typeof manuals.$inferSelect;

function toAuthor(v: string): ManualAuthor {
  return v === "you" ? "you" : "coach";
}

function toTrigger(v: string | null): ManualTrigger | null {
  return v === "fasting" ? v : null;
}

function toManual(r: ManualRow): Manual {
  return {
    id: r.id,
    title: r.title,
    situation: r.situation,
    applies_when: toTrigger(r.appliesWhen),
    body: r.body,
    edited_by: toAuthor(r.editedBy),
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  };
}

/** Every manual, most recently changed first. */
export async function listManuals(): Promise<Manual[]> {
  const rows = await db.select().from(manuals).orderBy(desc(manuals.updatedAt));
  return rows.map(toManual);
}

export async function getManual(id: number): Promise<Manual | null> {
  const rows = await db.select().from(manuals).where(eq(manuals.id, id)).limit(1);
  const row = rows[0];
  return row ? toManual(row) : null;
}

/** The manual that loads by itself in this situation, if there is one. */
export async function getManualFor(trigger: ManualTrigger): Promise<Manual | null> {
  const rows = await db
    .select()
    .from(manuals)
    .where(eq(manuals.appliesWhen, trigger))
    .orderBy(desc(manuals.updatedAt))
    .limit(1);
  const row = rows[0];
  return row ? toManual(row) : null;
}

export interface ManualDraft {
  title: string;
  situation: string;
  applies_when: ManualTrigger | null;
  body: string;
}

/**
 * Only one manual loads for a situation, so claiming one takes it off any
 * other — otherwise which one the coach saw would depend on the clock.
 */
async function releaseTrigger(trigger: ManualTrigger | null, keep: number): Promise<void> {
  if (!trigger) return;
  await db
    .update(manuals)
    .set({ appliesWhen: null })
    .where(and(eq(manuals.appliesWhen, trigger), sql`${manuals.id} != ${keep}`));
}

export async function addManual(draft: ManualDraft, by: ManualAuthor): Promise<number> {
  const now = new Date().toISOString();
  const rows = await db
    .insert(manuals)
    .values({
      title: draft.title,
      situation: draft.situation,
      appliesWhen: draft.applies_when,
      body: draft.body,
      editedBy: by,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: manuals.id });
  const id = rows[0]?.id ?? 0;
  await releaseTrigger(draft.applies_when, id);
  return id;
}

/**
 * Replace a manual, keeping what it said before as a revision. A save that
 * changes nothing writes nothing, so the history only holds real changes.
 * Returns false if the manual is gone.
 */
export async function updateManual(
  id: number,
  draft: ManualDraft,
  by: ManualAuthor,
): Promise<boolean> {
  const current = await getManual(id);
  if (!current) return false;
  const same =
    current.title === draft.title &&
    current.situation === draft.situation &&
    current.applies_when === draft.applies_when &&
    current.body === draft.body;
  if (same) return true;
  await db.insert(manualRevisions).values({
    manualId: id,
    title: current.title,
    situation: current.situation,
    body: current.body,
    editedBy: current.edited_by,
    writtenAt: current.updated_at,
  });
  await db
    .update(manuals)
    .set({
      title: draft.title,
      situation: draft.situation,
      appliesWhen: draft.applies_when,
      body: draft.body,
      editedBy: by,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(manuals.id, id));
  await releaseTrigger(draft.applies_when, id);
  return true;
}

export async function deleteManual(id: number): Promise<void> {
  await db.delete(manualRevisions).where(eq(manualRevisions.manualId, id));
  await db.delete(manuals).where(eq(manuals.id, id));
}

/** A manual's earlier versions, newest first. */
export async function listManualRevisions(manualId: number): Promise<ManualRevision[]> {
  const rows = await db
    .select()
    .from(manualRevisions)
    .where(eq(manualRevisions.manualId, manualId))
    .orderBy(desc(manualRevisions.id));
  return rows.map((r) => ({
    id: r.id,
    manual_id: r.manualId,
    title: r.title,
    situation: r.situation,
    body: r.body,
    edited_by: toAuthor(r.editedBy),
    written_at: r.writtenAt,
  }));
}

// ---------------------------------------------------------------------------
// Experiments
// ---------------------------------------------------------------------------

type ExperimentRow = typeof experiments.$inferSelect;
type TrialRow = typeof experimentTrials.$inferSelect;

function toExperimentStatus(v: string): ExperimentStatus {
  return v === "concluded" || v === "dropped" ? v : "running";
}

function toExperiment(r: ExperimentRow): Experiment {
  return {
    id: r.id,
    title: r.title,
    hypothesis: r.hypothesis,
    applies_when: toTrigger(r.appliesWhen),
    arms: parseExperimentArms(r.arms),
    measures: parseExperimentMeasures(r.measures),
    assignment: r.assignment === "choose" ? "choose" : "balanced",
    target_per_arm: r.targetPerArm,
    status: toExperimentStatus(r.status),
    conclusion: r.conclusion,
    manual_id: r.manualId,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
    ended_at: r.endedAt,
  };
}

function toTrial(r: TrialRow): ExperimentTrial {
  return {
    id: r.id,
    experiment_id: r.experimentId,
    arm: r.arm,
    fast_id: r.fastId,
    started_at: r.startedAt,
    day: r.day,
    tz_offset_min: r.tzOffsetMin,
    ratings: parseTrialRatings(r.ratings),
    note: r.note,
    excluded: r.excluded !== 0,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  };
}

/** Every experiment, running ones first, then most recently changed. */
export async function listExperiments(): Promise<Experiment[]> {
  const rows = await db
    .select()
    .from(experiments)
    .orderBy(sql`${experiments.status} != 'running'`, desc(experiments.updatedAt));
  return rows.map(toExperiment);
}

export async function getExperiment(id: number): Promise<Experiment | null> {
  const rows = await db.select().from(experiments).where(eq(experiments.id, id)).limit(1);
  const row = rows[0];
  return row ? toExperiment(row) : null;
}

/** Running experiments whose trials the app opens itself in this situation. */
export async function listRunningExperimentsFor(trigger: ManualTrigger): Promise<Experiment[]> {
  const rows = await db
    .select()
    .from(experiments)
    .where(and(eq(experiments.appliesWhen, trigger), eq(experiments.status, "running")))
    .orderBy(experiments.id);
  return rows.map(toExperiment);
}

export interface ExperimentDraft {
  title: string;
  hypothesis: string;
  applies_when: ManualTrigger | null;
  arms: ExperimentArm[];
  measures: ExperimentMeasure[];
  assignment: ExperimentAssignment;
  target_per_arm: number;
}

export async function addExperiment(draft: ExperimentDraft): Promise<number> {
  const now = new Date().toISOString();
  const rows = await db
    .insert(experiments)
    .values({
      title: draft.title,
      hypothesis: draft.hypothesis,
      appliesWhen: draft.applies_when,
      arms: JSON.stringify(draft.arms),
      measures: JSON.stringify(draft.measures),
      assignment: draft.assignment,
      targetPerArm: draft.target_per_arm,
      status: "running",
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: experiments.id });
  return rows[0]?.id ?? 0;
}

export interface ExperimentPatch extends Partial<ExperimentDraft> {
  status?: ExperimentStatus | undefined;
  conclusion?: string | null | undefined;
  manual_id?: number | null | undefined;
}

export async function updateExperiment(id: number, patch: ExperimentPatch): Promise<void> {
  const set: Partial<typeof experiments.$inferInsert> = { updatedAt: new Date().toISOString() };
  if (patch.title !== undefined) set.title = patch.title;
  if (patch.hypothesis !== undefined) set.hypothesis = patch.hypothesis;
  if (patch.applies_when !== undefined) set.appliesWhen = patch.applies_when;
  if (patch.arms !== undefined) set.arms = JSON.stringify(patch.arms);
  if (patch.measures !== undefined) set.measures = JSON.stringify(patch.measures);
  if (patch.assignment !== undefined) set.assignment = patch.assignment;
  if (patch.target_per_arm !== undefined) set.targetPerArm = patch.target_per_arm;
  if (patch.conclusion !== undefined) set.conclusion = patch.conclusion;
  if (patch.manual_id !== undefined) set.manualId = patch.manual_id;
  if (patch.status !== undefined) {
    set.status = patch.status;
    set.endedAt = patch.status === "running" ? null : set.updatedAt;
  }
  await db.update(experiments).set(set).where(eq(experiments.id, id));
}

export async function deleteExperiment(id: number): Promise<void> {
  await db.delete(experimentTrials).where(eq(experimentTrials.experimentId, id));
  await db.delete(experiments).where(eq(experiments.id, id));
}

/** An experiment's trials, oldest first. */
export async function listTrials(experimentId: number): Promise<ExperimentTrial[]> {
  const rows = await db
    .select()
    .from(experimentTrials)
    .where(eq(experimentTrials.experimentId, experimentId))
    .orderBy(experimentTrials.startedAt, experimentTrials.id);
  return rows.map(toTrial);
}

export async function getTrial(id: number): Promise<ExperimentTrial | null> {
  const rows = await db
    .select()
    .from(experimentTrials)
    .where(eq(experimentTrials.id, id))
    .limit(1);
  const row = rows[0];
  return row ? toTrial(row) : null;
}

/** Trials anchored to a fast, across every experiment. */
export async function listTrialsForFast(fastId: number): Promise<ExperimentTrial[]> {
  const rows = await db
    .select()
    .from(experimentTrials)
    .where(eq(experimentTrials.fastId, fastId))
    .orderBy(experimentTrials.id);
  return rows.map(toTrial);
}

export async function addTrial(t: {
  experiment_id: number;
  arm: string;
  fast_id: number | null;
  started_at: string;
  note?: string | null;
}): Promise<number> {
  const now = new Date().toISOString();
  const stamp = stampOf(t.started_at);
  const rows = await db
    .insert(experimentTrials)
    .values({
      experimentId: t.experiment_id,
      arm: t.arm,
      fastId: t.fast_id,
      startedAt: t.started_at,
      day: stamp.day,
      tzOffsetMin: stamp.tz_offset_min,
      note: t.note ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: experimentTrials.id });
  await db
    .update(experiments)
    .set({ updatedAt: now })
    .where(eq(experiments.id, t.experiment_id));
  return rows[0]?.id ?? 0;
}

export interface TrialPatch {
  arm?: string | undefined;
  ratings?: TrialRatings | null | undefined;
  note?: string | null | undefined;
  excluded?: boolean | undefined;
}

export async function updateTrial(id: number, patch: TrialPatch): Promise<void> {
  const set: Partial<typeof experimentTrials.$inferInsert> = {
    updatedAt: new Date().toISOString(),
  };
  if (patch.arm !== undefined) set.arm = patch.arm;
  if (patch.ratings !== undefined) {
    set.ratings = patch.ratings == null ? null : JSON.stringify(patch.ratings);
  }
  if (patch.note !== undefined) set.note = patch.note;
  if (patch.excluded !== undefined) set.excluded = patch.excluded ? 1 : 0;
  await db.update(experimentTrials).set(set).where(eq(experimentTrials.id, id));
}

export async function deleteTrial(id: number): Promise<void> {
  await db.delete(experimentTrials).where(eq(experimentTrials.id, id));
}

// ---------------------------------------------------------------------------
// Coach check-in history (cooldowns and the daily budget)
// ---------------------------------------------------------------------------

type CoachRunRow = typeof coachRuns.$inferSelect;

function toCoachRun(r: CoachRunRow): CoachRun {
  return {
    id: r.id,
    trigger_key: r.triggerKey,
    day: r.day,
    created_at: r.createdAt,
    chat_id: r.chatId,
  };
}

/** Check-ins since `sinceDay` (inclusive), newest first. */
export async function listCoachRunsSince(sinceDay: string): Promise<CoachRun[]> {
  const rows = await db
    .select()
    .from(coachRuns)
    .where(gte(coachRuns.day, sinceDay))
    .orderBy(desc(coachRuns.createdAt));
  return rows.map(toCoachRun);
}

export async function addCoachRun(
  triggerKey: string,
  day: string,
  chatId: number | null,
): Promise<void> {
  await db.insert(coachRuns).values({
    triggerKey,
    day,
    chatId,
    createdAt: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Day goal adjustments (manual calorie-target corrections)
// ---------------------------------------------------------------------------

type DayGoalAdjustmentRow = typeof dayGoalAdjustments.$inferSelect;

function toDayGoalAdjustment(r: DayGoalAdjustmentRow): DayGoalAdjustment {
  return {
    day: r.day,
    delta_kcal: r.deltaKcal,
    note: r.note,
    updated_at: r.updatedAt,
  };
}

/** Manual target corrections for local days `startDay`..`endDay`, inclusive. */
export async function listDayGoalAdjustments(
  startDay: string,
  endDay: string,
): Promise<DayGoalAdjustment[]> {
  const rows = await db
    .select()
    .from(dayGoalAdjustments)
    .where(
      and(gte(dayGoalAdjustments.day, startDay), lte(dayGoalAdjustments.day, endDay)),
    )
    .orderBy(dayGoalAdjustments.day);
  return rows.map(toDayGoalAdjustment);
}

/** Set (or replace) a day's manual correction. A delta of 0 clears the row. */
export async function setDayGoalAdjustment(
  day: string,
  deltaKcal: number,
  note: string | null = null,
): Promise<void> {
  if (!isFinite(deltaKcal) || Math.round(deltaKcal) === 0) {
    await clearDayGoalAdjustment(day);
    return;
  }
  const value = {
    day,
    deltaKcal: Math.round(deltaKcal),
    note,
    updatedAt: new Date().toISOString(),
  };
  await db
    .insert(dayGoalAdjustments)
    .values(value)
    .onConflictDoUpdate({
      target: dayGoalAdjustments.day,
      set: { deltaKcal: value.deltaKcal, note, updatedAt: value.updatedAt },
    });
}

export async function clearDayGoalAdjustment(day: string): Promise<void> {
  await db.delete(dayGoalAdjustments).where(eq(dayGoalAdjustments.day, day));
}

// ---------------------------------------------------------------------------
// Full-history reads (streak & achievements engine)
//
// Tally is a single-user local app — whole-table scans over a few years of
// diary data stay in the low thousands of rows, well within budget.
// ---------------------------------------------------------------------------

export async function listAllFoodEntries(): Promise<FoodEntry[]> {
  const rows = await db.select().from(foodEntries).orderBy(foodEntries.eatenAt);
  return rows.map(toFoodEntry);
}

export async function listAllWorkouts(): Promise<Workout[]> {
  const rows = await db.select().from(workouts).orderBy(workouts.performedAt);
  return rows.map(toWorkout);
}

export async function listAllSupplementLogs(): Promise<SupplementLogWithSupplement[]> {
  const rows = await db
    .select({
      id: supplementLogs.id,
      supplement_id: supplementLogs.supplementId,
      taken_at: supplementLogs.takenAt,
      amount: supplementLogs.amount,
      day: supplementLogs.day,
      tz_offset_min: supplementLogs.tzOffsetMin,
      name: supplements.name,
      dose_amount: supplements.doseAmount,
      dose_unit: supplements.doseUnit,
      nutrients: supplements.nutrients,
    })
    .from(supplementLogs)
    .innerJoin(supplements, eq(supplements.id, supplementLogs.supplementId))
    .orderBy(supplementLogs.takenAt);
  return rows.map((r) => ({ ...r, nutrients: sanitizeNutrients(r.nutrients) }));
}

/** All captures still in the inbox (pending/error) — successes are deleted. */
export async function listAllCaptures(): Promise<Capture[]> {
  const rows = await db.select().from(captures);
  return rows.map(toCapture);
}

// ---------------------------------------------------------------------------
// Blood readings — glucose and ketones off a meter, in mmol/L
// ---------------------------------------------------------------------------

type ReadingRow = typeof bloodReadings.$inferSelect;

const toBloodReading = (r: ReadingRow): BloodReading => {
  if (!isReadingKind(r.kind)) throw new Error(`Reading #${r.id} has kind "${r.kind}"`);
  return {
    id: r.id,
    measured_at: r.measuredAt,
    kind: r.kind,
    value: r.value,
    note: r.note,
    day: r.day,
    tz_offset_min: r.tzOffsetMin,
    photo_path: r.photoPath,
  };
};

export async function addBloodReading(reading: {
  kind: ReadingKind;
  /** mmol/L. */
  value: number;
  note?: string | null;
  /** The meter-screen photo it was read from. */
  photoPath?: string | null;
  /** ISO instant; defaults to now. */
  measuredAt?: string;
}): Promise<number> {
  const measuredAt = reading.measuredAt ?? new Date().toISOString();
  const stamp = stampOf(measuredAt);
  const rows = await db
    .insert(bloodReadings)
    .values({
      measuredAt,
      kind: reading.kind,
      value: reading.value,
      note: reading.note?.trim() || null,
      day: stamp.day,
      tzOffsetMin: stamp.tz_offset_min,
      photoPath: reading.photoPath ?? null,
    })
    .returning({ id: bloodReadings.id });
  return rows[0]?.id ?? 0;
}

export async function getBloodReading(id: number): Promise<BloodReading | null> {
  const rows = await db.select().from(bloodReadings).where(eq(bloodReadings.id, id)).limit(1);
  const row = rows[0];
  return row ? toBloodReading(row) : null;
}

export async function updateBloodReading(reading: BloodReading): Promise<void> {
  await db
    .update(bloodReadings)
    .set({
      measuredAt: reading.measured_at,
      kind: reading.kind,
      value: reading.value,
      note: reading.note,
      // Re-stamped in the offset it already carries, as with states.
      day: dayOf(reading.measured_at, reading.tz_offset_min),
      tzOffsetMin: reading.tz_offset_min,
    })
    .where(eq(bloodReadings.id, reading.id));
}

export async function deleteBloodReading(id: number): Promise<void> {
  await db.delete(bloodReadings).where(eq(bloodReadings.id, id));
}

/** Readings taken on local days `startDay`..`endDay`, newest first. */
export async function listBloodReadingsForRange(
  startDay: string,
  endDay: string,
): Promise<BloodReading[]> {
  const rows = await db
    .select()
    .from(bloodReadings)
    .where(and(gte(bloodReadings.day, startDay), lte(bloodReadings.day, endDay)))
    .orderBy(desc(bloodReadings.measuredAt));
  return rows.map(toBloodReading);
}

// ---------------------------------------------------------------------------
// Performance stats — FTP, VO2 max, HRV… read off a watch app's screen
// ---------------------------------------------------------------------------

type PerfLogRow = typeof performanceLogs.$inferSelect;
type PerfStatRow = typeof performanceStats.$inferSelect;

const toPerformanceStat = (r: PerfStatRow): PerformanceStat => ({
  id: r.id,
  log_id: r.logId,
  metric: r.metric,
  label: r.label,
  value: r.value,
  unit: r.unit,
});

function toPerformanceLog(r: PerfLogRow, stats: PerfStatRow[]): PerformanceLog {
  return {
    id: r.id,
    measured_at: r.measuredAt,
    title: r.title,
    note: r.note,
    photo_path: r.photoPath,
    model_id: r.modelId,
    day: r.day,
    tz_offset_min: r.tzOffsetMin,
    stats: stats.filter((s) => s.logId === r.id).map(toPerformanceStat),
  };
}

async function withStats(rows: PerfLogRow[]): Promise<PerformanceLog[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const stats = await db
    .select()
    .from(performanceStats)
    .where(inArray(performanceStats.logId, ids))
    .orderBy(performanceStats.id);
  return rows.map((r) => toPerformanceLog(r, stats));
}

export async function addPerformanceLog(log: {
  title: string;
  note?: string | null;
  photoPath?: string | null;
  modelId?: string | null;
  /** ISO instant; defaults to now. */
  measuredAt?: string;
  stats: { metric: string; label: string; value: number; unit: string | null }[];
}): Promise<number> {
  const measuredAt = log.measuredAt ?? new Date().toISOString();
  const stamp = stampOf(measuredAt);
  const rows = await db
    .insert(performanceLogs)
    .values({
      measuredAt,
      title: log.title,
      note: log.note?.trim() || null,
      photoPath: log.photoPath ?? null,
      modelId: log.modelId ?? null,
      day: stamp.day,
      tzOffsetMin: stamp.tz_offset_min,
    })
    .returning({ id: performanceLogs.id });
  const id = rows[0]?.id ?? 0;
  if (id && log.stats.length > 0) {
    await db.insert(performanceStats).values(
      log.stats.map((s) => ({
        logId: id,
        metric: s.metric,
        label: s.label,
        value: s.value,
        unit: s.unit,
      })),
    );
  }
  return id;
}

export async function getPerformanceLog(id: number): Promise<PerformanceLog | null> {
  const rows = await db.select().from(performanceLogs).where(eq(performanceLogs.id, id)).limit(1);
  return (await withStats(rows))[0] ?? null;
}

/** The log's own fields; its stats are edited one at a time below. */
export async function updatePerformanceLog(log: PerformanceLog): Promise<void> {
  await db
    .update(performanceLogs)
    .set({
      measuredAt: log.measured_at,
      title: log.title,
      note: log.note,
      day: dayOf(log.measured_at, log.tz_offset_min),
      tzOffsetMin: log.tz_offset_min,
    })
    .where(eq(performanceLogs.id, log.id));
}

export async function updatePerformanceStat(id: number, value: number): Promise<void> {
  await db.update(performanceStats).set({ value }).where(eq(performanceStats.id, id));
}

export async function deletePerformanceStat(id: number): Promise<void> {
  await db.delete(performanceStats).where(eq(performanceStats.id, id));
}

/** Deletes the log and its stats; the caller cleans up the photo after. */
export async function deletePerformanceLog(id: number): Promise<void> {
  await db.delete(performanceStats).where(eq(performanceStats.logId, id));
  await db.delete(performanceLogs).where(eq(performanceLogs.id, id));
}

/** Logs measured on local days `startDay`..`endDay`, newest first. */
export async function listPerformanceLogsForRange(
  startDay: string,
  endDay: string,
): Promise<PerformanceLog[]> {
  const rows = await db
    .select()
    .from(performanceLogs)
    .where(and(gte(performanceLogs.day, startDay), lte(performanceLogs.day, endDay)))
    .orderBy(desc(performanceLogs.measuredAt));
  return withStats(rows);
}

// ---------------------------------------------------------------------------
// Saved meals
// ---------------------------------------------------------------------------

type SavedMealRow = typeof savedMeals.$inferSelect;

function toSavedMeal(r: SavedMealRow): SavedMeal {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    nutrients: sanitizeNutrients(r.nutrients),
    icon: r.icon,
    source_entry_id: r.sourceEntryId,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  };
}

/** Every saved meal, alphabetically. */
export async function listSavedMeals(): Promise<SavedMeal[]> {
  const rows = await db.select().from(savedMeals).orderBy(sql`lower(${savedMeals.name})`);
  return rows.map(toSavedMeal);
}

export async function getSavedMeal(id: number): Promise<SavedMeal | null> {
  const rows = await db.select().from(savedMeals).where(eq(savedMeals.id, id)).limit(1);
  const row = rows[0];
  return row ? toSavedMeal(row) : null;
}

/**
 * Save a meal under a name. A name already saved (in any case) is updated in
 * place rather than duplicated: saving a correction again means "these are
 * the right numbers now".
 */
export async function saveMeal(meal: {
  name: string;
  description: string | null;
  nutrients: SavedMeal["nutrients"];
  icon: string | null;
  source_entry_id: number | null;
}): Promise<{ id: number; updated: boolean }> {
  const now = new Date().toISOString();
  const name = meal.name.trim();
  const existing = await db
    .select({ id: savedMeals.id })
    .from(savedMeals)
    .where(sql`lower(${savedMeals.name}) = lower(${name})`)
    .limit(1);
  const values = {
    name,
    description: meal.description,
    nutrients: sanitizeNutrients(meal.nutrients),
    icon: meal.icon,
    sourceEntryId: meal.source_entry_id,
    updatedAt: now,
  };
  const found = existing[0];
  if (found) {
    await db.update(savedMeals).set(values).where(eq(savedMeals.id, found.id));
    return { id: found.id, updated: true };
  }
  const rows = await db
    .insert(savedMeals)
    .values({ ...values, createdAt: now })
    .returning({ id: savedMeals.id });
  return { id: rows[0]?.id ?? 0, updated: false };
}

/** Rename a saved meal; false when there is no such meal. */
export async function renameSavedMeal(id: number, name: string): Promise<boolean> {
  const rows = await db
    .update(savedMeals)
    .set({ name: name.trim(), updatedAt: new Date().toISOString() })
    .where(eq(savedMeals.id, id))
    .returning({ id: savedMeals.id });
  return rows.length > 0;
}

/** False when there was no such meal. */
export async function deleteSavedMeal(id: number): Promise<boolean> {
  const rows = await db
    .delete(savedMeals)
    .where(eq(savedMeals.id, id))
    .returning({ id: savedMeals.id });
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Incompletely tracked days
// ---------------------------------------------------------------------------

/** Days in `startDay`..`endDay` marked as incompletely tracked. */
export async function listIncompleteDays(startDay: string, endDay: string): Promise<Set<string>> {
  const rows = await db
    .select({ day: incompleteDays.day })
    .from(incompleteDays)
    .where(and(gte(incompleteDays.day, startDay), lte(incompleteDays.day, endDay)));
  return new Set(rows.map((r) => r.day));
}

export async function isDayIncomplete(day: string): Promise<boolean> {
  return (await listIncompleteDays(day, day)).has(day);
}

export async function setDayIncomplete(day: string, incomplete: boolean): Promise<void> {
  if (incomplete) {
    await db
      .insert(incompleteDays)
      .values({ day, updatedAt: new Date().toISOString() })
      .onConflictDoNothing();
  } else {
    await db.delete(incompleteDays).where(eq(incompleteDays.day, day));
  }
}

// ---------------------------------------------------------------------------
// Coach notes on entries
// ---------------------------------------------------------------------------

export const NOTED_ENTRY_KINDS: NotedEntryKind[] = [
  "meal",
  "workout",
  "reading",
  "state",
  "performance",
  "sleep",
];

export function isNotedEntryKind(v: unknown): v is NotedEntryKind {
  return typeof v === "string" && (NOTED_ENTRY_KINDS as string[]).includes(v);
}

type EntryNoteRow = typeof entryNotes.$inferSelect;

function toEntryNote(r: EntryNoteRow): EntryNote | null {
  if (!isNotedEntryKind(r.entryKind)) return null;
  return {
    id: r.id,
    entry_kind: r.entryKind,
    entry_id: r.entryId,
    text: r.text,
    created_at: r.createdAt,
  };
}

/** Does the entry a note would go on exist? A short title for it when it does. */
export async function describeNotedEntry(
  kind: NotedEntryKind,
  id: number,
): Promise<string | null> {
  if (kind === "meal") {
    const r = await db.select({ t: foodEntries.title }).from(foodEntries).where(eq(foodEntries.id, id)).limit(1);
    return r[0]?.t ?? null;
  }
  if (kind === "workout") {
    const r = await db.select({ t: workouts.title }).from(workouts).where(eq(workouts.id, id)).limit(1);
    return r[0]?.t ?? null;
  }
  if (kind === "reading") {
    const r = await db
      .select({ k: bloodReadings.kind, v: bloodReadings.value })
      .from(bloodReadings)
      .where(eq(bloodReadings.id, id))
      .limit(1);
    const row = r[0];
    return row ? `${row.k} ${Math.round(row.v * 10) / 10} mmol/L` : null;
  }
  if (kind === "state") {
    const r = await db.select({ t: stateLogs.label }).from(stateLogs).where(eq(stateLogs.id, id)).limit(1);
    return r[0]?.t ?? null;
  }
  if (kind === "performance") {
    const r = await db.select({ t: performanceLogs.title }).from(performanceLogs).where(eq(performanceLogs.id, id)).limit(1);
    return r[0]?.t ?? null;
  }
  const r = await db.select({ d: sleepSessions.day }).from(sleepSessions).where(eq(sleepSessions.id, id)).limit(1);
  return r[0] ? `night ending ${r[0].d ?? "?"}` : null;
}

export async function addEntryNote(
  kind: NotedEntryKind,
  entryId: number,
  text: string,
): Promise<number> {
  const rows = await db
    .insert(entryNotes)
    .values({ entryKind: kind, entryId, text, createdAt: new Date().toISOString() })
    .returning({ id: entryNotes.id });
  return rows[0]?.id ?? 0;
}

export async function listEntryNotes(kind: NotedEntryKind, entryId: number): Promise<EntryNote[]> {
  const rows = await db
    .select()
    .from(entryNotes)
    .where(and(eq(entryNotes.entryKind, kind), eq(entryNotes.entryId, entryId)))
    .orderBy(entryNotes.createdAt);
  return rows.map(toEntryNote).filter((n): n is EntryNote => n !== null);
}

/** Notes on many entries of one kind at once, grouped by entry id. */
export async function listEntryNotesFor(
  kind: NotedEntryKind,
  entryIds: number[],
): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>();
  if (entryIds.length === 0) return out;
  const rows = await db
    .select()
    .from(entryNotes)
    .where(and(eq(entryNotes.entryKind, kind), inArray(entryNotes.entryId, entryIds)))
    .orderBy(entryNotes.createdAt);
  for (const r of rows) out.set(r.entryId, [...(out.get(r.entryId) ?? []), r.text]);
  return out;
}

export async function deleteEntryNote(id: number): Promise<void> {
  await db.delete(entryNotes).where(eq(entryNotes.id, id));
}

/** Called when an entry is deleted, so its notes don't outlive it. */
export async function deleteEntryNotesOf(kind: NotedEntryKind, entryId: number): Promise<void> {
  await db
    .delete(entryNotes)
    .where(and(eq(entryNotes.entryKind, kind), eq(entryNotes.entryId, entryId)));
}

/** How glucose is typed in and shown; mmol/L until they say otherwise. */
export async function getGlucoseUnit(): Promise<GlucoseUnit> {
  const v = await getSetting(SETTING_KEYS.glucoseUnit);
  return isGlucoseUnit(v) ? v : "mmol";
}

export async function setGlucoseUnit(unit: GlucoseUnit): Promise<void> {
  await setSetting(SETTING_KEYS.glucoseUnit, unit);
}

// ---------------------------------------------------------------------------
// States — how they felt, with a time on it
// ---------------------------------------------------------------------------

type StateRow = typeof stateLogs.$inferSelect;

const toStateLog = (r: StateRow): StateLog => ({
  id: r.id,
  logged_at: r.loggedAt,
  label: r.label,
  icon: r.icon,
  note: r.note,
  day: r.day,
  tz_offset_min: r.tzOffsetMin,
});

export async function addStateLog(log: {
  label: string;
  icon?: string | null;
  note?: string | null;
  /** ISO instant; defaults to now. */
  loggedAt?: string;
}): Promise<number> {
  const loggedAt = log.loggedAt ?? new Date().toISOString();
  const stamp = stampOf(loggedAt);
  const rows = await db
    .insert(stateLogs)
    .values({
      loggedAt,
      label: log.label,
      icon: log.icon ?? null,
      note: log.note?.trim() || null,
      day: stamp.day,
      tzOffsetMin: stamp.tz_offset_min,
    })
    .returning({ id: stateLogs.id });
  return rows[0]?.id ?? 0;
}

export async function getStateLog(id: number): Promise<StateLog | null> {
  const rows = await db.select().from(stateLogs).where(eq(stateLogs.id, id)).limit(1);
  const row = rows[0];
  return row ? toStateLog(row) : null;
}

export async function updateStateLog(log: StateLog): Promise<void> {
  await db
    .update(stateLogs)
    .set({
      loggedAt: log.logged_at,
      label: log.label,
      icon: log.icon,
      note: log.note,
      // Re-stamped from the (possibly edited) time in the offset it already
      // carries, so retiming a state logged abroad keeps it where it was.
      day: dayOf(log.logged_at, log.tz_offset_min),
      tzOffsetMin: log.tz_offset_min,
    })
    .where(eq(stateLogs.id, log.id));
}

export async function deleteStateLog(id: number): Promise<void> {
  await db.delete(stateLogs).where(eq(stateLogs.id, id));
}

export async function listStateLogsForDay(day: string): Promise<StateLog[]> {
  return listStateLogsForRange(day, day);
}

/** States logged on local days `startDay`..`endDay`, newest first. */
export async function listStateLogsForRange(
  startDay: string,
  endDay: string,
): Promise<StateLog[]> {
  const rows = await db
    .select()
    .from(stateLogs)
    .where(and(gte(stateLogs.day, startDay), lte(stateLogs.day, endDay)))
    .orderBy(desc(stateLogs.loggedAt));
  return rows.map(toStateLog);
}

/**
 * The states they keep an eye on, in the order they added them — the three
 * the app starts with first, then their own.
 */
export async function listStateCategories(): Promise<StateCategory[]> {
  const rows = await db.select().from(stateCategories).orderBy(stateCategories.id);
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    icon: r.icon,
    created_at: r.createdAt,
  }));
}

/**
 * Add one, or hand back the one that is already there.
 *
 * Matching on the words rather than the exact string: someone who types
 * "bloated" a fortnight after tapping "Bloated" means the same thing, and a
 * list with both in it is the beginning of a mess.
 */
export async function addStateCategory(
  label: string,
  icon: string,
): Promise<StateCategory> {
  const name = label.trim();
  const existing = (await listStateCategories()).find(
    (c) => stateKey(c.label) === stateKey(name),
  );
  if (existing) return existing;
  const created_at = new Date().toISOString();
  const rows = await db
    .insert(stateCategories)
    .values({ label: name, icon, createdAt: created_at })
    .returning({ id: stateCategories.id });
  return { id: rows[0]?.id ?? 0, label: name, icon, created_at };
}

/**
 * Take one off the list. States already logged under it keep their name and
 * their emoji — they are a record of a day, not a reference to this row.
 */
export async function deleteStateCategory(id: number): Promise<void> {
  await db.delete(stateCategories).where(eq(stateCategories.id, id));
}


// ---------------------------------------------------------------------------
// Per-entry threads
// ---------------------------------------------------------------------------

/** The conversation on one entry, oldest first. */
export async function listEntryMessages(
  kind: EntryKind,
  entryId: number,
): Promise<EntryMessage[]> {
  const rows = await db
    .select()
    .from(entryMessages)
    .where(and(eq(entryMessages.entryKind, kind), eq(entryMessages.entryId, entryId)))
    .orderBy(entryMessages.id);
  return rows.map((r) => ({
    id: r.id,
    role: r.role === "user" ? "user" : "assistant",
    text: r.text,
    changes: parseEntryChanges(r.changes),
    before: parseEntrySnapshot(r.beforeEntry),
    created_at: r.createdAt,
  }));
}

export async function addEntryMessage(m: {
  kind: EntryKind;
  entryId: number;
  role: "user" | "assistant";
  text: string;
  /** What it changed, already worded for display. */
  changes?: string[];
  /** The entry as it stood before it, when it rewrote one. */
  before?: FoodEntry | Workout | null;
}): Promise<void> {
  await db.insert(entryMessages).values({
    entryKind: m.kind,
    entryId: m.entryId,
    role: m.role,
    text: m.text,
    changes: m.changes ?? [],
    beforeEntry: m.before ?? null,
    createdAt: new Date().toISOString(),
  });
}

/**
 * Forget an entry's conversation — called when the entry itself goes, since a
 * thread about a meal that no longer exists is unreachable anyway, and ids get
 * reused by AUTOINCREMENT's absence of promises.
 */
export async function deleteEntryMessages(
  kind: EntryKind,
  entryId: number,
): Promise<void> {
  await db
    .delete(entryMessages)
    .where(and(eq(entryMessages.entryKind, kind), eq(entryMessages.entryId, entryId)));
}

// ---------------------------------------------------------------------------
// Achievements
// ---------------------------------------------------------------------------

/** Map of achievement key → unlock timestamp (ISO). */
export async function listUnlockedAchievements(): Promise<Map<string, string>> {
  const rows = await db.select().from(achievements);
  return new Map(rows.map((r) => [r.key, r.unlockedAt]));
}

/** Idempotent unlock; returns true only when the row was newly inserted. */
export async function insertAchievement(key: string, unlockedAt: string): Promise<boolean> {
  const rows = await db
    .insert(achievements)
    .values({ key, unlockedAt })
    .onConflictDoNothing()
    .returning({ key: achievements.key });
  return rows.length > 0;
}
