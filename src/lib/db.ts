import Database from "@tauri-apps/plugin-sql";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { and, desc, eq, gt, gte, isNotNull, isNull, lte, sql } from "drizzle-orm";
import {
  achievements,
  captures,
  chats,
  coachMemory,
  coachRuns,
  dayGoalAdjustments,
  documents,
  fasts,
  foodEntries,
  healthMetrics,
  settings,
  sleepSessions,
  supplementLogs,
  supplements,
  workouts,
} from "../db/schema";
import type {
  Capture,
  ChatSummary,
  CoachMemory,
  CoachRun,
  DayGoalAdjustment,
  LibraryDocument,
  Fast,
  FoodEntry,
  HealthMetric,
  SleepSession,
  Supplement,
  SupplementLogWithSupplement,
  Workout,
} from "./types";
import type { ChatMessage } from "./openrouter";
import { FAST_BREAK_KCAL } from "./types";
import { sanitizeNutrients } from "./nutrients";
import { dayOf, stampOf } from "./daystamp";
import { deletePhoto } from "./photos";
import {
  parseChatTranscript,
  parseDocumentPages,
  parseDocumentValues,
  parseJson,
} from "./schemas";

const DB_URL = "sqlite:tally.db";

let sqlitePromise: Promise<Database> | null = null;

function sqlite(): Promise<Database> {
  if (!sqlitePromise) sqlitePromise = Database.load(DB_URL);
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
  };
}

/**
 * The day and offset are stamped here rather than passed in: they are a fact
 * about the moment being logged, and every caller would otherwise have to
 * remember to derive them the same way (see lib/daystamp.ts).
 */
export async function addFoodEntry(
  entry: Omit<FoodEntry, "id" | "day" | "tz_offset_min">,
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

export async function deleteFoodEntry(id: number): Promise<void> {
  await db.delete(foodEntries).where(eq(foodEntries.id, id));
}

export async function listFoodEntriesForDay(day: string): Promise<FoodEntry[]> {
  return listFoodEntriesForRange(day, day);
}

/**
 * ISO timestamp of the most recently eaten entry that counts as a meal for
 * fasting (>= FAST_BREAK_KCAL, or no calorie estimate), or null if none.
 * Sub-threshold entries — black coffee, broth — never move the anchor.
 */
export async function getLastMealAt(): Promise<string | null> {
  const kcal = sql`json_extract(${foodEntries.nutrients}, '$.calories')`;
  const rows = await db
    .select({ eatenAt: foodEntries.eatenAt })
    .from(foodEntries)
    .where(sql`(${kcal} IS NULL OR ${kcal} >= ${FAST_BREAK_KCAL})`)
    .orderBy(desc(foodEntries.eatenAt))
    .limit(1);
  return rows[0]?.eatenAt ?? null;
}

/**
 * Fast-breaking meals (see FAST_BREAK_KCAL; missing calories counts) eaten
 * strictly after `sinceIso`, oldest first. Used to warn about meals tracked
 * inside an active fast's window — strict inequality keeps the anchor meal
 * the fast started from out of its own warning.
 */
export async function listMealsSince(sinceIso: string): Promise<FoodEntry[]> {
  const kcal = sql`json_extract(${foodEntries.nutrients}, '$.calories')`;
  const rows = await db
    .select()
    .from(foodEntries)
    .where(
      and(
        gt(foodEntries.eatenAt, sinceIso),
        sql`(${kcal} IS NULL OR ${kcal} >= ${FAST_BREAK_KCAL})`,
      ),
    )
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
  "id" | "source" | "external_id" | "day" | "tz_offset_min"
> &
  Partial<Pick<Workout, "source" | "external_id">>;

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
  w: Omit<Workout, "id" | "day" | "tz_offset_min"> & {
    external_id: string;
    /** Offset the source recorded it in; falls back to here. */
    tz_offset_min?: number | null;
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
      modelId: w.model_id,
      icon: w.icon,
      source: w.source,
      externalId: w.external_id,
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
        source: w.source,
      },
    });
}

export async function updateWorkout(w: Workout): Promise<void> {
  await db
    .update(workouts)
    .set({
      performedAt: w.performed_at,
      title: w.title,
      description: w.description,
      photoPath: w.photo_path,
      caloriesBurned: w.calories_burned,
      durationMin: w.duration_min,
      modelId: w.model_id,
      icon: w.icon,
    })
    .where(eq(workouts.id, w.id));
}

export async function deleteWorkout(id: number): Promise<void> {
  await db.delete(workouts).where(eq(workouts.id, id));
}

export async function listWorkoutsForDay(day: string): Promise<Workout[]> {
  return listWorkoutsForRange(day, day);
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
// Photo files (shared by filename across rows)
// ---------------------------------------------------------------------------
//
// A photo is stored once on disk and referenced by bare filename. When a
// capture resolves into an entry, that filename is passed THROUGH to the
// food/workout entry (see agent.ts) — so the same file is pointed at by the
// capture and the entry it produced, and can outlive either one. Deleting the
// file whenever a single referrer goes away is what orphaned surviving entries'
// images (a discarded capture taking its already-logged meal's photo with it).

/**
 * Does any capture, food entry, or workout still reference this photo file?
 * Callers delete the owning row FIRST, then ask — so a file shared only with
 * the just-deleted row reads as unreferenced.
 */
export async function isPhotoReferenced(filename: string): Promise<boolean> {
  const [inFood, inWorkouts, inCaptures, inDocuments] = await Promise.all([
    db.select({ id: foodEntries.id }).from(foodEntries).where(eq(foodEntries.photoPath, filename)).limit(1),
    db.select({ id: workouts.id }).from(workouts).where(eq(workouts.photoPath, filename)).limit(1),
    db.select({ id: captures.id }).from(captures).where(eq(captures.photoPath, filename)).limit(1),
    db.select({ id: documents.id }).from(documents).where(eq(documents.photoPath, filename)).limit(1),
  ]);
  return (
    inFood.length > 0 ||
    inWorkouts.length > 0 ||
    inCaptures.length > 0 ||
    inDocuments.length > 0
  );
}

/**
 * Delete a stored photo from disk only when no diary row still points at it.
 * This is the safe replacement for a bare `deletePhoto` after removing a row:
 * delete the row first, then call this so a file another entry still uses is
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

export async function addSupplement(s: Omit<Supplement, "id">): Promise<number> {
  const rows = await db
    .insert(supplements)
    .values({
      name: s.name,
      doseAmount: s.dose_amount,
      doseUnit: s.dose_unit,
      nutrients: s.nutrients,
      notes: s.notes,
      archived: s.archived,
    })
    .returning({ id: supplements.id });
  return rows[0]?.id ?? 0;
}

export async function updateSupplement(s: Supplement): Promise<void> {
  await db
    .update(supplements)
    .set({
      name: s.name,
      doseAmount: s.dose_amount,
      doseUnit: s.dose_unit,
      nutrients: s.nutrients,
      notes: s.notes,
      archived: s.archived,
    })
    .where(eq(supplements.id, s.id));
}

/** Deletes a supplement and all of its logs. */
export async function deleteSupplement(id: number): Promise<void> {
  await db.delete(supplementLogs).where(eq(supplementLogs.supplementId, id));
  await db.delete(supplements).where(eq(supplements.id, id));
}

// ---------------------------------------------------------------------------
// Supplement logs
// ---------------------------------------------------------------------------

export async function addSupplementLog(
  supplementId: number,
  amount: number,
  takenAt: string,
): Promise<number> {
  const stamp = stampOf(takenAt);
  const rows = await db
    .insert(supplementLogs)
    .values({
      supplementId,
      takenAt,
      amount,
      day: stamp.day,
      tzOffsetMin: stamp.tz_offset_min,
    })
    .returning({ id: supplementLogs.id });
  return rows[0]?.id ?? 0;
}

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

export async function deleteSupplementLog(id: number): Promise<void> {
  await db.delete(supplementLogs).where(eq(supplementLogs.id, id));
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
// Fasts
// ---------------------------------------------------------------------------

type FastRow = typeof fasts.$inferSelect;

function toFast(r: FastRow): Fast {
  return {
    id: r.id,
    started_at: r.startedAt,
    goal_hours: r.goalHours,
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

export async function insertFast(goalHours: number, startedAt: string): Promise<Fast> {
  const stamp = stampOf(startedAt);
  const rows = await db
    .insert(fasts)
    .values({
      startedAt,
      goalHours,
      endedAt: null,
      startDay: stamp.day,
      tzOffsetMin: stamp.tz_offset_min,
    })
    .returning({ id: fasts.id });
  return {
    id: rows[0]?.id ?? 0,
    started_at: startedAt,
    goal_hours: goalHours,
    ended_at: null,
    start_day: stamp.day,
    end_day: null,
    tz_offset_min: stamp.tz_offset_min,
  };
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
