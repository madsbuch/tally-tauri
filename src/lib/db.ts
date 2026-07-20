import Database from "@tauri-apps/plugin-sql";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { and, desc, eq, gte, isNotNull, isNull, lt, sql } from "drizzle-orm";
import {
  fasts,
  foodEntries,
  settings,
  supplementLogs,
  supplements,
  workouts,
} from "../db/schema";
import type {
  Fast,
  FoodEntry,
  Supplement,
  SupplementLogWithSupplement,
  Workout,
} from "./types";
import { sanitizeNutrients } from "./nutrients";

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

/**
 * Local-day boundaries as UTC ISO strings, for querying timestamp columns.
 * `day` is "YYYY-MM-DD" in the user's local timezone.
 */
export function dayRange(day: string): { start: string; end: string } {
  const [y, m, d] = day.split("-").map(Number);
  const start = new Date(y, m - 1, d);
  const end = new Date(y, m - 1, d + 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

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
  return rows.length > 0 ? rows[0].value : null;
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
  };
}

export async function addFoodEntry(entry: Omit<FoodEntry, "id">): Promise<number> {
  const rows = await db
    .insert(foodEntries)
    .values({
      eatenAt: entry.eaten_at,
      title: entry.title,
      description: entry.description,
      photoPath: entry.photo_path,
      nutrients: entry.nutrients,
      modelId: entry.model_id,
    })
    .returning({ id: foodEntries.id });
  return rows[0]?.id ?? 0;
}

export async function updateFoodEntry(entry: FoodEntry): Promise<void> {
  await db
    .update(foodEntries)
    .set({
      eatenAt: entry.eaten_at,
      title: entry.title,
      description: entry.description,
      photoPath: entry.photo_path,
      nutrients: entry.nutrients,
      modelId: entry.model_id,
    })
    .where(eq(foodEntries.id, entry.id));
}

export async function deleteFoodEntry(id: number): Promise<void> {
  await db.delete(foodEntries).where(eq(foodEntries.id, id));
}

export async function listFoodEntriesForDay(day: string): Promise<FoodEntry[]> {
  const { start, end } = dayRange(day);
  const rows = await db
    .select()
    .from(foodEntries)
    .where(and(gte(foodEntries.eatenAt, start), lt(foodEntries.eatenAt, end)))
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
  };
}

export async function addWorkout(w: Omit<Workout, "id">): Promise<number> {
  const rows = await db
    .insert(workouts)
    .values({
      performedAt: w.performed_at,
      title: w.title,
      description: w.description,
      photoPath: w.photo_path,
      caloriesBurned: w.calories_burned,
      durationMin: w.duration_min,
      modelId: w.model_id,
    })
    .returning({ id: workouts.id });
  return rows[0]?.id ?? 0;
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
    })
    .where(eq(workouts.id, w.id));
}

export async function deleteWorkout(id: number): Promise<void> {
  await db.delete(workouts).where(eq(workouts.id, id));
}

export async function listWorkoutsForDay(day: string): Promise<Workout[]> {
  const { start, end } = dayRange(day);
  const rows = await db
    .select()
    .from(workouts)
    .where(and(gte(workouts.performedAt, start), lt(workouts.performedAt, end)))
    .orderBy(desc(workouts.performedAt));
  return rows.map(toWorkout);
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
  const rows = await db
    .insert(supplementLogs)
    .values({ supplementId, takenAt, amount })
    .returning({ id: supplementLogs.id });
  return rows[0]?.id ?? 0;
}

export async function updateSupplementLog(
  id: number,
  amount: number,
  takenAt: string,
): Promise<void> {
  await db
    .update(supplementLogs)
    .set({ amount, takenAt })
    .where(eq(supplementLogs.id, id));
}

export async function deleteSupplementLog(id: number): Promise<void> {
  await db.delete(supplementLogs).where(eq(supplementLogs.id, id));
}

export async function listSupplementLogsForDay(
  day: string,
): Promise<SupplementLogWithSupplement[]> {
  const { start, end } = dayRange(day);
  // Field names are unique across the two tables — required, since the
  // proxy's positional mapping collapses duplicate column names.
  const rows = await db
    .select({
      id: supplementLogs.id,
      supplement_id: supplementLogs.supplementId,
      taken_at: supplementLogs.takenAt,
      amount: supplementLogs.amount,
      name: supplements.name,
      dose_amount: supplements.doseAmount,
      dose_unit: supplements.doseUnit,
      nutrients: supplements.nutrients,
    })
    .from(supplementLogs)
    .innerJoin(supplements, eq(supplements.id, supplementLogs.supplementId))
    .where(and(gte(supplementLogs.takenAt, start), lt(supplementLogs.takenAt, end)))
    .orderBy(desc(supplementLogs.takenAt));
  return rows.map((r) => ({ ...r, nutrients: sanitizeNutrients(r.nutrients) }));
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
  };
}

export async function getActiveFast(): Promise<Fast | null> {
  const rows = await db
    .select()
    .from(fasts)
    .where(isNull(fasts.endedAt))
    .orderBy(desc(fasts.startedAt))
    .limit(1);
  return rows.length > 0 ? toFast(rows[0]) : null;
}

export async function insertFast(goalHours: number, startedAt: string): Promise<Fast> {
  const rows = await db
    .insert(fasts)
    .values({ startedAt, goalHours, endedAt: null })
    .returning({ id: fasts.id });
  return {
    id: rows[0]?.id ?? 0,
    started_at: startedAt,
    goal_hours: goalHours,
    ended_at: null,
  };
}

export async function markFastEnded(id: number, endedAt: string): Promise<void> {
  await db.update(fasts).set({ endedAt }).where(eq(fasts.id, id));
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
