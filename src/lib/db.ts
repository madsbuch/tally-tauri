import Database from "@tauri-apps/plugin-sql";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { and, desc, eq, gt, gte, isNotNull, isNull, lt, lte, sql } from "drizzle-orm";
import {
  achievements,
  captures,
  chats,
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
  const [y = 0, m = 1, d = 1] = day.split("-").map(Number);
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
  const start = dayRange(startDay).start;
  const end = dayRange(endDay).end;
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
    source: r.source,
    external_id: r.externalId,
  };
}

/** Manual/agent entries omit `source`/`external_id` — they default to null. */
export type NewWorkout = Omit<Workout, "id" | "source" | "external_id"> &
  Partial<Pick<Workout, "source" | "external_id">>;

export async function addWorkout(w: NewWorkout): Promise<number> {
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
  w: Omit<Workout, "id"> & { external_id: string },
): Promise<void> {
  await db
    .insert(workouts)
    .values({
      performedAt: w.performed_at,
      title: w.title,
      description: w.description,
      photoPath: w.photo_path,
      caloriesBurned: w.calories_burned,
      durationMin: w.duration_min,
      modelId: w.model_id,
      source: w.source,
      externalId: w.external_id,
    })
    .onConflictDoUpdate({
      target: workouts.externalId,
      set: {
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
  const start = dayRange(startDay).start;
  const end = dayRange(endDay).end;
  const rows = await db
    .select()
    .from(workouts)
    .where(and(gte(workouts.performedAt, start), lt(workouts.performedAt, end)))
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
  };
}

/** Insert-or-update a sleep session, keyed on its Health Connect UID. */
export async function upsertSleepSession(
  s: Omit<SleepSession, "id">,
): Promise<void> {
  const values = {
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
  await db
    .insert(sleepSessions)
    .values(values)
    .onConflictDoUpdate({ target: sleepSessions.externalId, set: values });
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
  const start = dayRange(startDay).start;
  const end = dayRange(endDay).end;
  const rows = await db
    .select()
    .from(sleepSessions)
    .where(and(gte(sleepSessions.endedAt, start), lt(sleepSessions.endedAt, end)))
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
  return listSupplementLogsForRange(day, day);
}

/** Supplement logs from local day `startDay` through `endDay`, both inclusive. */
export async function listSupplementLogsForRange(
  startDay: string,
  endDay: string,
): Promise<SupplementLogWithSupplement[]> {
  const start = dayRange(startDay).start;
  const end = dayRange(endDay).end;
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
  const raw = rows[0]?.messages;
  if (raw === undefined) return null;
  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  return Array.isArray(parsed) ? (parsed as ChatMessage[]) : null;
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

/** Every fast ever recorded (active one included), oldest first. */
export async function listAllFasts(): Promise<Fast[]> {
  const rows = await db.select().from(fasts).orderBy(fasts.startedAt);
  return rows.map(toFast);
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
