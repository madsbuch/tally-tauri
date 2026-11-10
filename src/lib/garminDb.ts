import { and, eq, getTableColumns, gte, inArray, isNotNull, like, lte, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { garminActivities, garminDays, healthMetrics, sleepSessions, workouts } from "../db/schema";
import { db, upsertSleepSession } from "./db";
import { dayOf, stampOf } from "./daystamp";
import { bestSessionMatch, recordIdNames, sameNight } from "./syncMatch";
import type { Span } from "./syncMatch";
import type { GarminActivity, GarminLap } from "./schemas";
import {
  parseGarminLoadBalance,
  parseStoredGarminLaps,
  parseStoredTrainingStatusRaw,
  parseStoredZoneSecs,
} from "./schemas";
import type { GarminLoadBalance } from "./schemas";

// ---------------------------------------------------------------------------
// Storage for the Garmin Connect sync (lib/garmin.ts), and the two halves of
// keeping it and Health Connect from duplicating each other:
//  - a Garmin activity attaches to the workout Health Connect already wrote
//    (linkGarminActivity), and only gets a row of its own when there's none;
//  - Health Connect, meeting a session the Garmin sync created first, takes
//    that row over instead of adding another (adoptGarminWorkout/Sleep).
// Health Connect stays the owner of the core rows; Garmin only adds detail.
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

export type LinkOutcome = "exact" | "time" | "created" | "updated" | "skipped";

type ActivityIn = GarminActivity & { id: string; startMs: number };

function spanOfWorkout(performedAt: string, durationMin: number | null): Span {
  const startMs = Date.parse(performedAt);
  return { startMs, endMs: startMs + (durationMin ?? 0) * 60_000 };
}

function spanOfActivity(a: ActivityIn): Span {
  return { startMs: a.startMs, endMs: a.startMs + (a.durationSec ?? 0) * 1000 };
}

const TITLE_CASE = (key: string) =>
  key
    .split("_")
    .filter(Boolean)
    .map((w, i) => (i === 0 ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");

/** "Running · 5.3 km · avg HR 142" — like the Health Connect sync's. */
function describe(a: ActivityIn): string {
  const parts = [a.typeKey ? TITLE_CASE(a.typeKey) : "Workout"];
  if (a.distanceM != null && a.distanceM >= 100) parts.push(`${(a.distanceM / 1000).toFixed(1)} km`);
  if (a.avgHr != null && a.avgHr > 0) parts.push(`avg HR ${Math.round(a.avgHr)}`);
  return parts.join(" · ");
}

/**
 * Synced workouts (Health Connect or Garmin-created) within a day of `startMs`
 * that no other Garmin activity has claimed.
 */
async function unclaimedSyncedWorkoutsNear(startMs: number, activityId: string) {
  return db
    .select({
      id: workouts.id,
      performedAt: workouts.performedAt,
      durationMin: workouts.durationMin,
      sourceRecordId: workouts.sourceRecordId,
    })
    .from(workouts)
    .where(
      and(
        isNotNull(workouts.externalId),
        gte(workouts.performedAt, iso(startMs - DAY_MS)),
        lte(workouts.performedAt, iso(startMs + DAY_MS)),
        sql`NOT EXISTS (SELECT 1 FROM ${garminActivities} WHERE ${garminActivities.workoutId} = ${workouts.id} AND ${garminActivities.activityId} <> ${activityId})`,
      ),
    );
}

function detailValues(a: ActivityIn, raw: Record<string, unknown>) {
  return {
    startedAt: iso(a.startMs),
    durationSec: a.durationSec,
    typeKey: a.typeKey,
    name: a.name,
    distanceM: a.distanceM,
    avgHr: a.avgHr,
    maxHr: a.maxHr,
    calories: a.calories,
    aerobicTe: a.aerobicTe,
    anaerobicTe: a.anaerobicTe,
    teLabel: a.teLabel,
    trainingLoad: a.trainingLoad,
    avgPower: a.avgPower,
    maxPower: a.maxPower,
    normPower: a.normPower,
    avgCadence: a.avgCadence,
    elevationGainM: a.elevationGainM,
    avgSpeedMps: a.avgSpeedMps,
    vo2Max: a.vo2Max,
    zoneSecs: a.zoneSecs,
    summary: raw,
    updatedAt: new Date().toISOString(),
  };
}

function workoutValuesFor(a: ActivityIn) {
  const durationMin = a.durationSec != null ? Math.round(a.durationSec / 60) : null;
  return {
    performedAt: iso(a.startMs),
    title: a.name?.trim() || (a.typeKey ? TITLE_CASE(a.typeKey) : "Workout"),
    description: describe(a),
    caloriesBurned: Math.round(a.activeCalories ?? 0),
    durationMin: durationMin != null && durationMin > 0 ? durationMin : null,
  };
}

/**
 * Store one Garmin activity and attach it to its diary workout: the one it
 * already belongs to, else the Health Connect row naming it (exact) or
 * recorded at the same time, else a new row — unless the user deleted its
 * workout before, in which case it is only ever re-attached, never re-made.
 */
export async function linkGarminActivity(
  a: ActivityIn,
  raw: Record<string, unknown>,
): Promise<LinkOutcome> {
  const details = detailValues(a, raw);
  const [existing] = await db
    .select({
      workoutId: garminActivities.workoutId,
      dismissed: garminActivities.dismissed,
      linkedBy: garminActivities.linkedBy,
    })
    .from(garminActivities)
    .where(eq(garminActivities.activityId, a.id));

  if (existing?.workoutId != null) {
    const [w] = await db
      .select({ id: workouts.id, externalId: workouts.externalId })
      .from(workouts)
      .where(eq(workouts.id, existing.workoutId));
    if (w) {
      await db.update(garminActivities).set(details).where(eq(garminActivities.activityId, a.id));
      // A row Garmin made (and Health Connect hasn't taken over) follows
      // edits made in Garmin Connect; never the icon, cardio or Zone 2 marks.
      if (w.externalId?.startsWith("garmin:")) {
        await db.update(workouts).set(workoutValuesFor(a)).where(eq(workouts.id, w.id));
      }
      return "updated";
    }
  }

  const candidates = await unclaimedSyncedWorkoutsNear(a.startMs, a.id);
  let match: { id: number; how: "exact" | "time" } | null = null;
  const exact = candidates.find((c) => recordIdNames(c.sourceRecordId, a.id));
  if (exact) {
    match = { id: exact.id, how: "exact" };
  } else {
    const best = bestSessionMatch(
      spanOfActivity(a),
      candidates.map((c) => ({ id: c.id, ...spanOfWorkout(c.performedAt, c.durationMin) })),
    );
    if (best) match = { id: best.id, how: "time" };
  }

  let workoutId: number | null = match?.id ?? null;
  let outcome: LinkOutcome = match?.how ?? "skipped";
  if (!match && !existing?.dismissed) {
    const tzOffsetMin = a.offsetMin ?? stampOf(iso(a.startMs)).tz_offset_min;
    const values = workoutValuesFor(a);
    const [row] = await db
      .insert(workouts)
      .values({
        ...values,
        day: dayOf(values.performedAt, tzOffsetMin),
        tzOffsetMin,
        source: "Garmin",
        externalId: `garmin:${a.id}`,
      })
      .onConflictDoUpdate({ target: workouts.externalId, set: values })
      .returning({ id: workouts.id });
    workoutId = row?.id ?? null;
    outcome = "created";
  }

  const linkedBy = outcome === "skipped" ? (existing?.linkedBy ?? null) : outcome;
  await db
    .insert(garminActivities)
    .values({
      activityId: a.id,
      workoutId,
      dismissed: workoutId == null ? (existing?.dismissed ?? 0) : 0,
      linkedBy,
      ...details,
    })
    .onConflictDoUpdate({
      target: garminActivities.activityId,
      set: {
        workoutId,
        dismissed: workoutId == null ? (existing?.dismissed ?? 0) : 0,
        linkedBy,
        ...details,
      },
    });
  return outcome;
}

/**
 * Health Connect side: before writing session `hcId`, take over the row the
 * Garmin sync created for the same activity, if there is one, so the upsert
 * that follows updates it instead of adding a twin.
 */
export async function adoptGarminWorkout(
  hcId: string,
  clientRecordId: string | null | undefined,
  span: Span,
): Promise<void> {
  const [own] = await db
    .select({ id: workouts.id })
    .from(workouts)
    .where(eq(workouts.externalId, hcId));
  if (own) return;
  const rows = await db
    .select({
      id: workouts.id,
      externalId: workouts.externalId,
      performedAt: workouts.performedAt,
      durationMin: workouts.durationMin,
    })
    .from(workouts)
    .where(
      and(
        like(workouts.externalId, "garmin:%"),
        gte(workouts.performedAt, iso(span.startMs - DAY_MS)),
        lte(workouts.performedAt, iso(span.startMs + DAY_MS)),
      ),
    );
  const exact = rows.find((r) => recordIdNames(clientRecordId, (r.externalId ?? "").slice(7)));
  const hit =
    exact ??
    bestSessionMatch(
      span,
      rows.map((r) => ({ id: r.id, ...spanOfWorkout(r.performedAt, r.durationMin) })),
    );
  if (!hit) return;
  await db.update(workouts).set({ externalId: hcId }).where(eq(workouts.id, hit.id));
}

/** The same for a night: take over the Garmin-made session it overlaps. */
export async function adoptGarminSleep(hcId: string, span: Span): Promise<void> {
  const [own] = await db
    .select({ id: sleepSessions.id })
    .from(sleepSessions)
    .where(eq(sleepSessions.externalId, hcId));
  if (own) return;
  const rows = await db
    .select({ id: sleepSessions.id, startedAt: sleepSessions.startedAt, endedAt: sleepSessions.endedAt })
    .from(sleepSessions)
    .where(
      and(
        like(sleepSessions.externalId, "garmin-sleep:%"),
        lte(sleepSessions.startedAt, iso(span.endMs)),
        gte(sleepSessions.endedAt, iso(span.startMs)),
      ),
    );
  const hit = rows.find((r) =>
    sameNight(span, { startMs: Date.parse(r.startedAt), endMs: Date.parse(r.endedAt) }),
  );
  if (!hit) return;
  await db.update(sleepSessions).set({ externalId: hcId }).where(eq(sleepSessions.id, hit.id));
}

/** Recent activities still without laps, newest first. */
export async function activitiesMissingLaps(sinceMs: number, limit: number): Promise<string[]> {
  const rows = await db
    .select({ id: garminActivities.activityId })
    .from(garminActivities)
    .where(
      and(
        sql`${garminActivities.laps} IS NULL`,
        gte(garminActivities.startedAt, iso(sinceMs)),
      ),
    )
    .orderBy(sql`${garminActivities.startedAt} DESC`)
    .limit(limit);
  return rows.map((r) => r.id);
}

export async function setGarminLaps(activityId: string, laps: GarminLap[]): Promise<void> {
  await db.update(garminActivities).set({ laps }).where(eq(garminActivities.activityId, activityId));
}

export type GarminDayRow = typeof garminDays.$inferInsert;

/**
 * Write a day, merging into what's there: a value only replaces another, never
 * erases it, and `raw` gains the new endpoints' answers beside the old. The
 * Personal API and the optional sign-in each fill part of a day (readiness
 * and training status only come from the latter), so neither may blank out
 * the other's columns.
 */
export async function upsertGarminDay(row: GarminDayRow): Promise<void> {
  const set: Record<string, SQL> = {};
  for (const [key, col] of Object.entries(getTableColumns(garminDays))) {
    if (key === "day") continue;
    const excluded = sql.raw(`excluded."${col.name}"`);
    set[key] =
      key === "raw"
        ? sql`json_patch(COALESCE(${garminDays.raw}, '{}'), COALESCE(${excluded}, '{}'))`
        : sql`COALESCE(${excluded}, ${col})`;
  }
  await db.insert(garminDays).values(row).onConflictDoUpdate({ target: garminDays.day, set });
}

/** Whether Garmin had anything at all for that day (for the backfill's end). */
export function garminDayHasData(row: GarminDayRow): boolean {
  return (
    row.steps != null ||
    row.restingHr != null ||
    row.sleepId != null ||
    row.caloriesTotal != null ||
    row.hrvLastNight != null
  );
}

/**
 * Health Connect wins; Garmin fills what it left empty. Insert days Health
 * Connect has no row for, and fill only the null columns of the ones it has.
 * Local and idempotent — run after either sync (a Health Connect full resync
 * wipes and rewrites its days, so the gaps need filling again).
 */
export async function fillHealthMetricsFromGarmin(): Promise<void> {
  const now = new Date().toISOString();
  await db.run(sql`
    INSERT INTO health_metrics (day, steps, resting_hr, hrv_ms, spo2_pct, weight_kg, vo2_max, calories_total, updated_at)
    SELECT day, steps, resting_hr, hrv_last_night, spo2_avg, weight_kg, vo2_max, calories_total, ${now}
    FROM garmin_days
    WHERE steps IS NOT NULL OR resting_hr IS NOT NULL OR hrv_last_night IS NOT NULL
      OR spo2_avg IS NOT NULL OR weight_kg IS NOT NULL OR vo2_max IS NOT NULL OR calories_total IS NOT NULL
    ON CONFLICT(day) DO UPDATE SET
      steps = COALESCE(health_metrics.steps, excluded.steps),
      resting_hr = COALESCE(health_metrics.resting_hr, excluded.resting_hr),
      hrv_ms = COALESCE(health_metrics.hrv_ms, excluded.hrv_ms),
      spo2_pct = COALESCE(health_metrics.spo2_pct, excluded.spo2_pct),
      weight_kg = COALESCE(health_metrics.weight_kg, excluded.weight_kg),
      vo2_max = COALESCE(health_metrics.vo2_max, excluded.vo2_max),
      calories_total = COALESCE(health_metrics.calories_total, excluded.calories_total)
  `);
  // Keep the reference to the table so a rename breaks the build, not the SQL.
  void healthMetrics;
}

/**
 * Nights Garmin knows that no synced sleep session covers get a session of
 * their own (keyed `garmin-sleep:<id>`). Returns how many were added.
 */
export async function fillSleepFromGarmin(): Promise<number> {
  const rows = await db
    .select({
      sleepId: garminDays.sleepId,
      startedAt: garminDays.sleepStartedAt,
      endedAt: garminDays.sleepEndedAt,
      tz: garminDays.sleepTzOffsetMin,
      deep: garminDays.sleepDeepMin,
      rem: garminDays.sleepRemMin,
      light: garminDays.sleepLightMin,
      awake: garminDays.sleepAwakeMin,
    })
    .from(garminDays)
    .where(
      and(
        isNotNull(garminDays.sleepId),
        isNotNull(garminDays.sleepStartedAt),
        isNotNull(garminDays.sleepEndedAt),
        // Any session in that window — Health Connect's, or the one made
        // here on an earlier sync — means the night is already there.
        sql`NOT EXISTS (SELECT 1 FROM ${sleepSessions} WHERE ${sleepSessions.startedAt} < ${garminDays.sleepEndedAt} AND ${sleepSessions.endedAt} > ${garminDays.sleepStartedAt})`,
      ),
    );
  let added = 0;
  for (const r of rows) {
    if (!r.sleepId || !r.startedAt || !r.endedAt) continue;
    const durationMin = Math.round((Date.parse(r.endedAt) - Date.parse(r.startedAt)) / 60_000);
    if (durationMin <= 0) continue;
    await upsertSleepSession({
      external_id: `garmin-sleep:${r.sleepId}`,
      started_at: r.startedAt,
      ended_at: r.endedAt,
      duration_min: durationMin,
      deep_min: r.deep,
      rem_min: r.rem,
      light_min: r.light,
      awake_min: r.awake,
      source: "Garmin",
      tz_offset_min: r.tz,
    });
    added++;
  }
  return added;
}

export interface GarminLinkReport {
  activities: number;
  exact: number;
  time: number;
  created: number;
  dismissed: number;
  days: number;
  earliestDay: string | null;
  /** Health Connect workouts that carry a clientRecordId, and one example. */
  hcWithRecordId: number;
  hcRecordIdExample: string | null;
}

/** What the Garmin sync has stored and how it attached it — for Settings. */
export async function garminLinkReport(): Promise<GarminLinkReport> {
  const byHow = await db
    .select({ how: garminActivities.linkedBy, dismissed: garminActivities.dismissed, n: sql<number>`count(*)` })
    .from(garminActivities)
    .groupBy(garminActivities.linkedBy, garminActivities.dismissed);
  const count = (how: string) =>
    byHow.filter((r) => r.how === how && !r.dismissed).reduce((s, r) => s + Number(r.n), 0);
  const [days] = await db
    .select({ n: sql<number>`count(*)`, earliest: sql<string | null>`min(${garminDays.day})` })
    .from(garminDays);
  const [rec] = await db
    .select({ n: sql<number>`count(*)`, example: sql<string | null>`max(${workouts.sourceRecordId})` })
    .from(workouts)
    .where(isNotNull(workouts.sourceRecordId));
  return {
    activities: byHow.reduce((s, r) => s + Number(r.n), 0),
    exact: count("exact"),
    time: count("time"),
    created: count("created"),
    dismissed: byHow.filter((r) => r.dismissed).reduce((s, r) => s + Number(r.n), 0),
    days: Number(days?.n ?? 0),
    earliestDay: days?.earliest ?? null,
    hcWithRecordId: Number(rec?.n ?? 0),
    hcRecordIdExample: rec?.example ?? null,
  };
}

/** Earliest Garmin activity day — how far back the wellness backfill goes. */
export async function earliestGarminActivityAt(): Promise<string | null> {
  const [r] = await db
    .select({ at: sql<string | null>`min(${garminActivities.startedAt})` })
    .from(garminActivities);
  return r?.at ?? null;
}

export interface GarminWorkoutDetail {
  workoutId: number;
  activityId: string;
  typeKey: string | null;
  distanceM: number | null;
  avgHr: number | null;
  maxHr: number | null;
  aerobicTe: number | null;
  anaerobicTe: number | null;
  teLabel: string | null;
  trainingLoad: number | null;
  avgPower: number | null;
  normPower: number | null;
  avgCadence: number | null;
  elevationGainM: number | null;
  avgSpeedMps: number | null;
  vo2Max: number | null;
  zoneSecs: number[] | null;
  laps: GarminLap[] | null;
}

/** Garmin's detail for these workouts, keyed by workout id. */
export async function garminDetailsForWorkouts(
  ids: number[],
): Promise<Map<number, GarminWorkoutDetail>> {
  const out = new Map<number, GarminWorkoutDetail>();
  if (ids.length === 0) return out;
  const rows = await db
    .select()
    .from(garminActivities)
    .where(inArray(garminActivities.workoutId, ids));
  for (const r of rows) {
    if (r.workoutId == null) continue;
    out.set(r.workoutId, {
      workoutId: r.workoutId,
      activityId: r.activityId,
      typeKey: r.typeKey,
      distanceM: r.distanceM,
      avgHr: r.avgHr,
      maxHr: r.maxHr,
      aerobicTe: r.aerobicTe,
      anaerobicTe: r.anaerobicTe,
      teLabel: r.teLabel,
      trainingLoad: r.trainingLoad,
      avgPower: r.avgPower,
      normPower: r.normPower,
      avgCadence: r.avgCadence,
      elevationGainM: r.elevationGainM,
      avgSpeedMps: r.avgSpeedMps,
      vo2Max: r.vo2Max,
      zoneSecs: parseStoredZoneSecs(r.zoneSecs),
      laps: r.laps == null ? null : parseStoredGarminLaps(r.laps),
    });
  }
  return out;
}

export type GarminDay = typeof garminDays.$inferSelect;

/** Garmin wellness days in a range, newest first (the `raw` blob left out). */
export async function listGarminDaysForRange(
  startDay: string,
  endDay: string,
): Promise<Omit<GarminDay, "raw">[]> {
  const rows = await db
    .select()
    .from(garminDays)
    .where(and(gte(garminDays.day, startDay), lte(garminDays.day, endDay)))
    .orderBy(sql`${garminDays.day} DESC`);
  return rows.map(({ raw: _raw, ...rest }) => rest);
}

/**
 * Garmin's own load focus for the newest day from `startDay` through `endDay`
 * that has one (it only comes with the optional sign-in), with that day.
 */
export async function latestGarminLoadBalance(
  startDay: string,
  endDay: string,
): Promise<{ day: string; balance: GarminLoadBalance } | null> {
  const rows = await db
    .select({ day: garminDays.day, raw: garminDays.raw })
    .from(garminDays)
    .where(and(gte(garminDays.day, startDay), lte(garminDays.day, endDay)))
    .orderBy(sql`${garminDays.day} DESC`);
  for (const r of rows) {
    const balance = parseGarminLoadBalance(parseStoredTrainingStatusRaw(r.raw));
    if (balance) return { day: r.day, balance };
  }
  return null;
}
