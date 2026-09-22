import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type { Nutrients } from "../lib/types";
import type { ChatMessage } from "../lib/schemas";

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const foodEntries = sqliteTable(
  "food_entries",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eatenAt: text("eaten_at").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    photoPath: text("photo_path"),
    nutrients: text("nutrients", { mode: "json" }).$type<Nutrients>().notNull().default({}),
    modelId: text("model_id"),
    /** Icon key picked by the AI when there's no photo (see lib/icons.ts). */
    icon: text("icon"),
  },
  (t) => [index("idx_food_entries_eaten_at").on(t.eatenAt)],
);

export const workouts = sqliteTable(
  "workouts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    performedAt: text("performed_at").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    photoPath: text("photo_path"),
    caloriesBurned: real("calories_burned").notNull().default(0),
    durationMin: real("duration_min"),
    modelId: text("model_id"),
    /** Icon key picked by the AI when there's no photo (see lib/icons.ts). */
    icon: text("icon"),
    /** Where the workout came from, e.g. "Garmin" — null = manual/agent entry. */
    source: text("source"),
    /** Stable id in the external system (Health Connect record UID) for dedup. */
    externalId: text("external_id"),
  },
  (t) => [
    index("idx_workouts_performed_at").on(t.performedAt),
    uniqueIndex("idx_workouts_external_id").on(t.externalId),
  ],
);

export const supplements = sqliteTable("supplements", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  doseAmount: real("dose_amount"),
  doseUnit: text("dose_unit"),
  nutrients: text("nutrients", { mode: "json" }).$type<Nutrients>().notNull().default({}),
  notes: text("notes"),
  archived: integer("archived").notNull().default(0),
});

export const supplementLogs = sqliteTable(
  "supplement_logs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    supplementId: integer("supplement_id")
      .notNull()
      .references(() => supplements.id),
    takenAt: text("taken_at").notNull(),
    amount: real("amount").notNull().default(1),
  },
  (t) => [index("idx_supplement_logs_taken_at").on(t.takenAt)],
);

/**
 * Fire-and-forget diary captures: created instantly when the user snaps a
 * photo/note, then resolved into real entries by the background agent.
 * Successful captures are deleted; failed ones stay with status "error".
 */
export const captures = sqliteTable(
  "captures",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    createdAt: text("created_at").notNull(),
    /** Local diary day ("YYYY-MM-DD") the capture was added to. */
    day: text("day").notNull(),
    note: text("note"),
    photoPath: text("photo_path"),
    status: text("status").notNull().default("pending"),
    error: text("error"),
  },
  (t) => [index("idx_captures_day").on(t.day)],
);

/** Sleep sessions synced from Health Connect (written by e.g. Garmin Connect). */
export const sleepSessions = sqliteTable(
  "sleep_sessions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Health Connect record UID for dedup. */
    externalId: text("external_id").notNull(),
    startedAt: text("started_at").notNull(),
    endedAt: text("ended_at").notNull(),
    durationMin: real("duration_min").notNull(),
    deepMin: real("deep_min"),
    remMin: real("rem_min"),
    lightMin: real("light_min"),
    awakeMin: real("awake_min"),
    source: text("source"),
  },
  (t) => [
    index("idx_sleep_sessions_started_at").on(t.startedAt),
    uniqueIndex("idx_sleep_sessions_external_id").on(t.externalId),
  ],
);

/**
 * One row per local day of wellness metrics synced from Health Connect
 * (steps, resting heart rate, HRV, SpO2, weight, VO2 max, total calories).
 * Sparse — a column is null when nothing was recorded that day.
 */
export const healthMetrics = sqliteTable("health_metrics", {
  /** Local day "YYYY-MM-DD". */
  day: text("day").primaryKey(),
  steps: integer("steps"),
  restingHr: real("resting_hr"),
  hrvMs: real("hrv_ms"),
  spo2Pct: real("spo2_pct"),
  weightKg: real("weight_kg"),
  vo2Max: real("vo2_max"),
  caloriesTotal: real("calories_total"),
  updatedAt: text("updated_at").notNull(),
});

/**
 * Saved assistant conversations. `messages` is the full OpenAI-style
 * transcript (system/user/assistant/tool) so a chat can be reopened and
 * continued with its context intact.
 */
export const chats = sqliteTable(
  "chats",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    title: text("title").notNull(),
    messages: text("messages", { mode: "json" }).$type<ChatMessage[]>().notNull(),
  },
  (t) => [index("idx_chats_updated_at").on(t.updatedAt)],
);

/**
 * Per-day corrections to the calorie target: "I overate yesterday, take 200
 * kcal off today". One row per local day; absence means no correction, and a
 * correction applies to that day only (see lib/goals.ts).
 */
export const dayGoalAdjustments = sqliteTable("day_goal_adjustments", {
  /** Local day "YYYY-MM-DD". */
  day: text("day").primaryKey(),
  /** Signed kcal added to that day's target (negative = a smaller budget). */
  deltaKcal: real("delta_kcal").notNull(),
  note: text("note"),
  updatedAt: text("updated_at").notNull(),
});

export const fasts = sqliteTable("fasts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  startedAt: text("started_at").notNull(),
  goalHours: real("goal_hours").notNull(),
  endedAt: text("ended_at"),
});

/**
 * What the coach knows about you, kept beside the chats rather than inside
 * them: goals you set, commitments you made, preferences you expressed, and
 * notes it took. A chat can end, be deleted, or scroll out of context — this
 * survives, so the next conversation starts informed instead of cold.
 */
export const coachMemory = sqliteTable(
  "coach_memory",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** "goal" | "commitment" | "preference" | "note" (see lib/coach.ts). */
    kind: text("kind").notNull(),
    text: text("text").notNull(),
    /** Commitments only: "open" | "done" | "dropped". Null for other kinds. */
    status: text("status"),
    /**
     * Local day ("YYYY-MM-DD") to come back to this on. A one-shot reminder:
     * raising it clears the date, and the coach re-arms it if the thing still
     * needs watching. Null means nothing to follow up.
     */
    followUpOn: text("follow_up_on"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("idx_coach_memory_kind").on(t.kind)],
);

/**
 * Every check-in the coach started, so it can't repeat itself. Gives the
 * trigger engine three things at once: when a trigger last fired (cooldown),
 * how many times it has spoken today (budget), and which chat it wrote into.
 */
export const coachRuns = sqliteTable(
  "coach_runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Trigger that won the evaluation (see lib/coachTriggers.ts). */
    triggerKey: text("trigger_key").notNull(),
    /** Local day "YYYY-MM-DD" it fired on. */
    day: text("day").notNull(),
    createdAt: text("created_at").notNull(),
    /** The chat it opened; null if writing the chat failed. */
    chatId: integer("chat_id"),
  },
  (t) => [index("idx_coach_runs_day").on(t.day)],
);

/** Unlocked gamification achievements — a row's presence means unlocked. */
export const achievements = sqliteTable("achievements", {
  key: text("key").primaryKey(),
  unlockedAt: text("unlocked_at").notNull(),
});
