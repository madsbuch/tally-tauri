import {
  blob,
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type { FoodEntry, Nutrients, Workout } from "../lib/types";
import type { ChatMessage, DocumentValue, GarminLap } from "../lib/schemas";

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
    /** Unused; left from the reverted diet feature so schema matches migrations. */
    diet: text("diet"),
    modelId: text("model_id"),
    /** Icon key picked by the AI when there's no photo (see lib/icons.ts). */
    icon: text("icon"),
    /**
     * Local day this happened on, stamped where it happened rather than
     * derived from wherever the phone is now (see lib/daystamp.ts).
     */
    day: text("day"),
    /** Minutes east of UTC at that moment, so the time reads as it was lived. */
    tzOffsetMin: integer("tz_offset_min"),
    /**
     * Why this entry doesn't break a fast ("black coffee", "within the 225 kcal
     * recoup allowance") — written by the diary agent against the running
     * fast's purpose, or by the user. Non-null exempts this one entry from
     * fasting checks; null means it counts as eating.
     */
    fastOkNote: text("fast_ok_note"),
  },
  (t) => [
    index("idx_food_entries_eaten_at").on(t.eatenAt),
    index("idx_food_entries_day").on(t.day),
  ],
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
    zone2Min: real("zone2_min"),
    /**
     * 1 = counts toward the cardio goal. Set by the user's switch, or, until
     * they touch it, by the Garmin sync from the activity's time in Zone 2.
     */
    cardio: integer("cardio").notNull().default(0),
    /** 1 = the user flipped the cardio switch; the Zone 2 rule leaves it alone. */
    cardioByHand: integer("cardio_by_hand").notNull().default(0),
    modelId: text("model_id"),
    /** Icon key picked by the AI when there's no photo (see lib/icons.ts). */
    icon: text("icon"),
    /** Where the workout came from, e.g. "Garmin" — null = manual/agent entry. */
    source: text("source"),
    /** Stable id in the external system (Health Connect record UID) for dedup. */
    externalId: text("external_id"),
    /**
     * Local day this happened on, stamped where it happened rather than
     * derived from wherever the phone is now (see lib/daystamp.ts).
     */
    day: text("day"),
    /** Minutes east of UTC at that moment, so the time reads as it was lived. */
    tzOffsetMin: integer("tz_offset_min"),
    /**
     * The writing app's own id for a Health Connect record (`clientRecordId`)
     * — Garmin's, when Garmin wrote it. Lets the Garmin Connect sync match
     * exactly instead of by time, when it carries the activity id.
     */
    sourceRecordId: text("source_record_id"),
  },
  (t) => [
    index("idx_workouts_performed_at").on(t.performedAt),
    uniqueIndex("idx_workouts_external_id").on(t.externalId),
    index("idx_workouts_day").on(t.day),
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
    /**
     * Local day this happened on, stamped where it happened rather than
     * derived from wherever the phone is now (see lib/daystamp.ts).
     */
    day: text("day"),
    /** Minutes east of UTC at that moment, so the time reads as it was lived. */
    tzOffsetMin: integer("tz_offset_min"),
  },
  (t) => [
    index("idx_supplement_logs_taken_at").on(t.takenAt),
    index("idx_supplement_logs_day").on(t.day),
  ],
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
    /**
     * Local day the night ENDED on — the morning it belongs to — stamped from
     * the sleeper's own timezone (Health Connect carries it) rather than
     * derived later from wherever the phone is.
     */
    day: text("day"),
    /** Minutes east of UTC where the night was slept. */
    tzOffsetMin: integer("tz_offset_min"),
    /** The writing app's own id for the Health Connect record, when set. */
    sourceRecordId: text("source_record_id"),
  },
  (t) => [
    index("idx_sleep_sessions_day").on(t.day),
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
  /**
   * What this fast is for, in the user's words ("recoup after the weekend,
   * up to 225 kcal is fine"). The diary agent judges mid-fast entries by it.
   */
  purpose: text("purpose"),
  endedAt: text("ended_at"),
  /** Local day the fast began on; every day through `endDay` counts as fasted. */
  startDay: text("start_day"),
  /** Local day it ended on; null while it's still running. */
  endDay: text("end_day"),
  /** Minutes east of UTC where it started. */
  tzOffsetMin: integer("tz_offset_min"),
});

/**
 * The document library: photographed blood results, reports, letters.
 *
 * Filed by `documentDate` — the date printed ON the document — rather than
 * when it was uploaded, so a result from March sits at March however long it
 * took to get photographed. That's what makes the library readable as a
 * history rather than a pile.
 *
 * The image is kept, but what the coach actually reads is the extracted text:
 * a summary and the individual measurements. Extracting once at upload keeps
 * every later conversation cheap, searchable, and usable by the scheduled
 * check-in, which has no vision call available to it.
 */
export const documents = sqliteTable(
  "documents",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    createdAt: text("created_at").notNull(),
    /** Local day the document refers to; null until it's been read. */
    documentDate: text("document_date"),
    title: text("title").notNull(),
    /** "lab" | "imaging" | "report" | "note" | "other". */
    kind: text("kind").notNull().default("other"),
    /** Filename of a row in the `photos` table. */
    photoPath: text("photo_path"),
    /** Whatever the user typed when adding it. */
    note: text("note"),
    summary: text("summary"),
    /** Measurements read off the document (see lib/schemas.ts). */
    extracted: text("extracted", { mode: "json" })
      .$type<DocumentValue[]>()
      .notNull()
      .default([]),
    /** "pending" | "ready" | "error". */
    status: text("status").notNull().default("pending"),
    error: text("error"),
    modelId: text("model_id"),
    /**
     * Every page of the document, in order, as filenames in the `photos` table. A PDF
     * arrives as several; a photograph as one. Empty on rows written before
     * multi-page documents existed, where `photoPath` is the only page.
     */
    pagePaths: text("page_paths", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default([]),
  },
  (t) => [index("idx_documents_document_date").on(t.documentDate)],
);

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
 * Manuals: what works for this person in one situation — a fast, a trip —
 * written up as a page they can read. Memory holds single observations and
 * rides along in every prompt; a manual gathers many of them into one page
 * that's only loaded when it applies. The coach writes and maintains them;
 * the person can read and edit them.
 */
export const manuals = sqliteTable("manuals", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  /** One line: when this manual applies ("When fasting longer than a day"). */
  situation: text("situation").notNull(),
  /**
   * A situation the app can detect itself, so the manual loads without the
   * coach having to notice: "fasting" while a fast is running. Null when only
   * the coach can tell.
   */
  appliesWhen: text("applies_when"),
  /** Markdown. */
  body: text("body").notNull(),
  /** Who wrote the current version: "coach" | "you". */
  editedBy: text("edited_by").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * Earlier versions of a manual, kept on every change so a rewrite by the
 * coach can be checked against what it replaced.
 */
export const manualRevisions = sqliteTable(
  "manual_revisions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    manualId: integer("manual_id")
      .notNull()
      .references(() => manuals.id),
    title: text("title").notNull(),
    situation: text("situation").notNull(),
    body: text("body").notNull(),
    editedBy: text("edited_by").notNull(),
    /** When this version was written (the manual's updated_at at the time). */
    writtenAt: text("written_at").notNull(),
  },
  (t) => [index("idx_manual_revisions_manual").on(t.manualId)],
);

/**
 * Experiments: something that might work, under test — "breaking a fast with
 * carbs first makes re-entry easier". Where a manual says what works, an
 * experiment is how a line earns its place there: a few options compared
 * over a handful of trials, with what counts as better written down before
 * the first one (see lib/experiments.ts).
 */
export const experiments = sqliteTable("experiments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  /** The idea being tested, in their words. */
  hypothesis: text("hypothesis").notNull(),
  /**
   * What one trial is: "fasting" makes every fast that ends while this runs a
   * trial, its refeed the thing being varied. Null when trials are logged by
   * hand (a day, a workout).
   */
  appliesWhen: text("applies_when"),
  /** JSON array of {key, label, detail} — the options compared. */
  arms: text("arms").notNull(),
  /** JSON array of {key, label, kind, better} — what is measured. */
  measures: text("measures").notNull(),
  /** "balanced" — the app picks the next option; "choose" — they do. */
  assignment: text("assignment").notNull(),
  /** Trials per option before it's worth concluding. */
  targetPerArm: integer("target_per_arm").notNull(),
  /** "running" | "concluded" | "dropped". */
  status: text("status").notNull(),
  /** What it showed, written when it ends. */
  conclusion: text("conclusion"),
  /** The manual the result went into, if any. */
  manualId: integer("manual_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  endedAt: text("ended_at"),
});

/**
 * One go at an experiment: which option it got, and how it went. For a
 * fasting experiment it is anchored to the fast it followed, and the numbers
 * the diary already holds (the refeed, the night after) are read from there
 * rather than copied in — only the ratings are theirs to give.
 */
export const experimentTrials = sqliteTable(
  "experiment_trials",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    experimentId: integer("experiment_id")
      .notNull()
      .references(() => experiments.id),
    /** The option's key ("A"). */
    arm: text("arm").notNull(),
    /** The fast it followed, for fasting experiments. */
    fastId: integer("fast_id"),
    /** When the trial began — for a refeed, the moment the fast ended. */
    startedAt: text("started_at").notNull(),
    /** Local day it began on. */
    day: text("day").notNull(),
    tzOffsetMin: integer("tz_offset_min").notNull(),
    /** JSON object of rating measure key → 1–5. Null until rated. */
    ratings: text("ratings"),
    note: text("note"),
    /** 1 when it shouldn't count (didn't follow the option, ill that day). */
    excluded: integer("excluded").notNull().default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("idx_experiment_trials_experiment").on(t.experimentId),
    index("idx_experiment_trials_fast").on(t.fastId),
  ],
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

/**
 * What the AI cost: one row per coach turn or check-in, with what OpenRouter
 * reported for every request in it. The ledger behind the spend shown in
 * Settings and on each chat, and behind the check-in's daily budget.
 */
export const aiUsage = sqliteTable(
  "ai_usage",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    createdAt: text("created_at").notNull(),
    /** Local day "YYYY-MM-DD" it was spent on. */
    day: text("day").notNull(),
    /** "coach" (a conversation turn) | "checkin" (the coach opening one). */
    source: text("source").notNull(),
    /** The chat it was spent in; null when none was saved. */
    chatId: integer("chat_id"),
    model: text("model").notNull(),
    requests: integer("requests").notNull(),
    promptTokens: integer("prompt_tokens").notNull(),
    /** Prompt tokens served from the provider's cache (billed far lower). */
    cachedTokens: integer("cached_tokens").notNull(),
    completionTokens: integer("completion_tokens").notNull(),
    costUsd: real("cost_usd").notNull(),
  },
  (t) => [index("idx_ai_usage_day").on(t.day), index("idx_ai_usage_chat").on(t.chatId)],
);

/** Unlocked gamification achievements — a row's presence means unlocked. */
export const achievements = sqliteTable("achievements", {
  key: text("key").primaryKey(),
  unlockedAt: text("unlocked_at").notNull(),
});

/**
 * The conversation attached to one diary entry.
 *
 * An estimate is a claim, and the honest response to a claim is often a
 * question — "why is that so high?", "does that include the oil?" — before it
 * is a correction. Questions and corrections arrive in the same words and are
 * told apart by what they mean, so they live in the same thread. The thread is
 * kept, with what each message changed and the entry it changed it from, so a
 * number can always be traced back to the sentence that moved it.
 */
export const entryMessages = sqliteTable(
  "entry_messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** "meal" | "workout" — which table `entryId` points into. */
    entryKind: text("entry_kind").notNull(),
    entryId: integer("entry_id").notNull(),
    /** "user" | "assistant". */
    role: text("role").notNull(),
    text: text("text").notNull(),
    /** What this message changed, worded for display; empty = it only talked. */
    changes: text("changes", { mode: "json" }).$type<string[]>().notNull().default([]),
    /**
     * The entry as it stood before this message rewrote it, so undo outlives
     * the visit. Null on every message that changed nothing.
     */
    beforeEntry: text("before_entry", { mode: "json" }).$type<FoodEntry | Workout>(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_entry_messages_entry").on(t.entryKind, t.entryId)],
);

/**
 * How you felt, with a time on it: "bloated", "depressive thoughts", "wired".
 *
 * The rest of the diary records what went in and what was burned. This records
 * what it was like — the half of a day people are usually tracking the other
 * half *for*. Kept as one row per state rather than a mood score, because
 * "bloated at 13:40" can be lined up against what was eaten at 12:15 and a
 * number out of ten can't.
 *
 * `label` and `icon` are copied from the category it was logged under, not a
 * reference to it: the row is a record of a day and must survive that
 * category being renamed or removed.
 */
export const stateLogs = sqliteTable(
  "state_logs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    loggedAt: text("logged_at").notNull(),
    label: text("label").notNull(),
    icon: text("icon"),
    /** Whatever else they wanted to say about it. */
    note: text("note"),
    /** Local day it happened on, stamped where it happened (lib/daystamp.ts). */
    day: text("day").notNull(),
    /** Minutes east of UTC at that moment, so the time reads as it was lived. */
    tzOffsetMin: integer("tz_offset_min").notNull(),
  },
  (t) => [
    index("idx_state_logs_day").on(t.day),
    index("idx_state_logs_logged_at").on(t.loggedAt),
  ],
);


/**
 * The states you can log, as a list you own.
 *
 * Not a fixed vocabulary shipped with the app: what is worth noticing is
 * personal, and a list of fifteen guesses is mostly clutter around the three
 * things you actually watch. So it starts at three, and grows only when you
 * add to it — which is also why the emoji lives here rather than in a code
 * table of keys. It belongs to the category, which belongs to the user.
 */
export const stateCategories = sqliteTable(
  "state_categories",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    label: text("label").notNull(),
    /** The emoji itself, picked by the model when the category was created. */
    icon: text("icon").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("idx_state_categories_label").on(t.label)],
);

/**
 * Rules for living — "I must always do things perfectly", "I'm a man, so I'm
 * dangerous". The sentences someone runs their life by without having chosen
 * them, kept in their own words (see lib/lifeRules.ts).
 *
 * `text` is stored exactly as they put it. A rule is only worth watching in
 * the wording it actually has in their head, and a tidied-up version is a
 * different rule. Rewording one later is part of the work, which is why each
 * log below keeps the wording it was logged under.
 */
export const lifeRules = sqliteTable(
  "life_rules",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    text: text("text").notNull(),
    /** The rule they are practising instead, if they have one yet. */
    alternative: text("alternative"),
    /**
     * "suggested" | "kept" | "archived". Suggested is one the diary agent
     * heard in a note without being told it was a rule: it waits for a Keep
     * before it counts as theirs. Archived ones stay so their history does.
     */
    status: text("status").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    /** Local day it was first written down, stamped where that happened. */
    day: text("day").notNull(),
    /** Minutes east of UTC at that moment. */
    tzOffsetMin: integer("tz_offset_min").notNull(),
  },
  (t) => [
    index("idx_life_rules_status").on(t.status),
    index("idx_life_rules_day").on(t.day),
  ],
);

/**
 * A time a rule came up: what set it off, how true it felt right then, and
 * whether they did what it said. Belief is the usual 0–100% — the number that
 * is supposed to move over months of noticing.
 */
export const lifeRuleLogs = sqliteTable(
  "life_rule_logs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ruleId: integer("rule_id")
      .notNull()
      .references(() => lifeRules.id),
    /** The rule's wording when this was logged; rewording must not rewrite it. */
    ruleText: text("rule_text").notNull(),
    loggedAt: text("logged_at").notNull(),
    day: text("day").notNull(),
    tzOffsetMin: integer("tz_offset_min").notNull(),
    /** What was going on, in their words. */
    situation: text("situation"),
    /** 0–100: how much they believed it in that moment. Null = not rated. */
    belief: integer("belief"),
    /** "yes" | "partly" | "no" — did they do what the rule said? */
    actedOn: text("acted_on"),
  },
  (t) => [
    index("idx_life_rule_logs_day").on(t.day),
    index("idx_life_rule_logs_rule").on(t.ruleId),
  ],
);

/**
 * Finger-prick readings off a blood meter (a FreeStyle Precision Neo, say):
 * glucose and β-ketones, one row per strip.
 *
 * Both are stored in mmol/L whatever the meter shows — ketones are only ever
 * read in mmol/L, and keeping glucose in the same unit is what lets the two
 * be divided into a glucose–ketone index. mg/dL is a display choice (see
 * lib/readings.ts), not a second kind of number in the table.
 */
export const bloodReadings = sqliteTable(
  "blood_readings",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    measuredAt: text("measured_at").notNull(),
    /** "glucose" | "ketone". */
    kind: text("kind").notNull(),
    /** mmol/L. */
    value: real("value").notNull(),
    /** Fasted, after a meal, after a workout — whatever they said about it. */
    note: text("note"),
    /** Local day it was measured on, stamped where it happened (lib/daystamp.ts). */
    day: text("day").notNull(),
    /** Minutes east of UTC at that moment. */
    tzOffsetMin: integer("tz_offset_min").notNull(),
    /**
     * The photo of the meter screen it was read from. A glucose and a ketone
     * strip photographed together share the one file.
     */
    photoPath: text("photo_path"),
  },
  (t) => [
    index("idx_blood_readings_day").on(t.day),
    index("idx_blood_readings_kind_measured_at").on(t.kind, t.measuredAt),
  ],
);

/**
 * Performance stats read off a watch app's screen — a Garmin screenshot of
 * FTP, VO₂ max, HRV status, lactate threshold, race predictions. One row per
 * screenshot (or note), with the numbers it showed in `performance_stats`.
 *
 * Kept apart from `health_metrics`, which Health Connect fills one value per
 * day: these are the numbers Garmin doesn't hand over (FTP, lactate threshold,
 * endurance score), and the screenshot they came from is kept with them.
 */
export const performanceLogs = sqliteTable(
  "performance_logs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    measuredAt: text("measured_at").notNull(),
    /** Short heading, e.g. "Garmin performance stats". */
    title: text("title").notNull(),
    note: text("note"),
    /** Filename of a row in the `photos` table: the screenshot itself. */
    photoPath: text("photo_path"),
    modelId: text("model_id"),
    /** Local day it was measured on, stamped where it happened (lib/daystamp.ts). */
    day: text("day").notNull(),
    /** Minutes east of UTC at that moment. */
    tzOffsetMin: integer("tz_offset_min").notNull(),
  },
  (t) => [
    index("idx_performance_logs_day").on(t.day),
    index("idx_performance_logs_measured_at").on(t.measuredAt),
  ],
);

/**
 * One number from a performance log. `metric` is a key from
 * lib/performance.ts ("ftp", "vo2max", …) or a slug of the label for anything
 * else the screen showed; `label` and `unit` are copied in so the row reads
 * on its own whatever the catalogue later says.
 */
export const performanceStats = sqliteTable(
  "performance_stats",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    logId: integer("log_id")
      .notNull()
      .references(() => performanceLogs.id),
    metric: text("metric").notNull(),
    label: text("label").notNull(),
    /** In `unit`; paces and times in seconds (see lib/performance.ts). */
    value: real("value").notNull(),
    unit: text("unit"),
  },
  (t) => [
    index("idx_performance_stats_log").on(t.logId),
    index("idx_performance_stats_metric").on(t.metric),
  ],
);

/**
 * Notes the coach attached to a diary entry: context that explains a number
 * without changing it — "taken ~10 min after coffee" on a glucose reading
 * that came out high. Kept apart from the entry's own note/description, which
 * are the user's words (and which a workout's Zone 2 minutes are read from),
 * so a note can never alter either. Add-only from the coach's side; the user
 * deletes them on the entry page.
 */
export const entryNotes = sqliteTable(
  "entry_notes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** "meal" | "workout" | "reading" | "state" | "performance" | "sleep". */
    entryKind: text("entry_kind").notNull(),
    entryId: integer("entry_id").notNull(),
    text: text("text").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_entry_notes_entry").on(t.entryKind, t.entryId)],
);

/**
 * Days the user marked with the Diary's "Incomplete tracking" switch. A row's
 * presence is the mark. Shown to the coach as-is.
 */
export const incompleteDays = sqliteTable("incomplete_days", {
  /** Local day "YYYY-MM-DD". */
  day: text("day").primaryKey(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * Meals kept for reuse: a 7-Eleven sourdough bun with its official label
 * values, "my usual breakfast". Saved from an entry the user corrected (the
 * entry's conversation saves it when they ask, or when they hand over a
 * product's official figures), and offered to the diary agent so the next
 * time it's eaten it's logged with the same numbers rather than re-estimated.
 * No screen of its own — the coach lists and removes them on request.
 */
export const savedMeals = sqliteTable(
  "saved_meals",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** What they call it; matched case-insensitively, so saving again updates. */
    name: text("name").notNull(),
    description: text("description"),
    /** Totals for one portion, as saved. */
    nutrients: text("nutrients", { mode: "json" }).$type<Nutrients>().notNull().default({}),
    icon: text("icon"),
    /** The food entry it was saved from, when it came from one. */
    sourceEntryId: integer("source_entry_id"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("idx_saved_meals_name").on(t.name)],
);

/**
 * Every stored image — meal photos, workout and performance screenshots,
 * captures, document pages, meter readings — so the whole app lives in the one
 * database file. Rows elsewhere point here by `filename` (their `photo_path`
 * and `page_paths` columns); several rows may share one image, so a photo is
 * only deleted once nothing references it (`deletePhotoIfUnused`). The bytes
 * are written and read by the Rust `save_photo` / `read_photo` commands, which
 * bind them as a real BLOB rather than shipping them through the SQL plugin.
 */
export const photos = sqliteTable("photos", {
  /** e.g. "1730987654321.jpg" — the key `photo_path` columns hold. */
  filename: text("filename").primaryKey(),
  /** The JPEG itself. */
  data: blob("data", { mode: "buffer" }).notNull(),
});

/**
 * Progress selfies: a picture of yourself now and then, to see change that the
 * scale and the tape don't show. Private by design — they're only shown on
 * their own page (Summary → Progress photos), never in the diary, and never
 * sent to a model or read by the coach.
 */
export const progressPhotos = sqliteTable(
  "progress_photos",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** When it was taken (for a picked older photo: the file's own time). */
    takenAt: text("taken_at").notNull(),
    /** Local day it was taken on, stamped where it happened (lib/daystamp.ts). */
    day: text("day").notNull(),
    /** Minutes east of UTC at that moment. */
    tzOffsetMin: integer("tz_offset_min").notNull(),
    /** Filename of a row in the `photos` table. */
    photoPath: text("photo_path").notNull(),
  },
  (t) => [index("idx_progress_photos_taken_at").on(t.takenAt)],
);

/**
 * Activities pulled straight from Garmin Connect (unofficial login, see
 * lib/garmin.ts) — everything Health Connect doesn't carry: Training Effect,
 * training load, time in HR zones, power, laps. Each one is linked to the
 * `workouts` row it is (usually the one Health Connect already synced, matched
 * by time — see lib/syncMatch.ts), so edits made to that row stay put; a
 * Garmin-only activity gets a row of its own, keyed `garmin:<id>`.
 */
export const garminActivities = sqliteTable(
  "garmin_activities",
  {
    /** Garmin's activity id. */
    activityId: text("activity_id").primaryKey(),
    /** The diary workout it is; null once the user deleted that workout. */
    workoutId: integer("workout_id"),
    /** 1 = its workout was deleted by hand — don't create it again. */
    dismissed: integer("dismissed").notNull().default(0),
    /** How it was linked: "exact" | "time" | "created". */
    linkedBy: text("linked_by"),
    startedAt: text("started_at").notNull(),
    durationSec: real("duration_sec"),
    /** Garmin's type key, e.g. "running", "strength_training". */
    typeKey: text("type_key"),
    name: text("name"),
    distanceM: real("distance_m"),
    avgHr: real("avg_hr"),
    maxHr: real("max_hr"),
    calories: real("calories"),
    aerobicTe: real("aerobic_te"),
    anaerobicTe: real("anaerobic_te"),
    /** Garmin's label for the session's main benefit, e.g. "TEMPO". */
    teLabel: text("te_label"),
    trainingLoad: real("training_load"),
    avgPower: real("avg_power"),
    maxPower: real("max_power"),
    normPower: real("norm_power"),
    avgCadence: real("avg_cadence"),
    elevationGainM: real("elevation_gain_m"),
    avgSpeedMps: real("avg_speed_mps"),
    vo2Max: real("vo2_max"),
    /** Seconds in HR zones 1–5, `[z1, z2, z3, z4, z5]`. */
    zoneSecs: text("zone_secs", { mode: "json" }).$type<number[]>(),
    /** Per-lap summaries; null until fetched (recent activities only). */
    laps: text("laps", { mode: "json" }).$type<GarminLap[]>(),
    /** Garmin's full activity summary, verbatim — nothing it said is lost. */
    summary: text("summary", { mode: "json" }).$type<Record<string, unknown>>(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("idx_garmin_activities_workout").on(t.workoutId),
    index("idx_garmin_activities_started_at").on(t.startedAt),
  ],
);

/**
 * One row per day of Garmin Connect wellness data — what Health Connect has
 * no record type for (Body Battery, stress, training readiness and status,
 * sleep score, HRV status) plus Garmin's own numbers for what it does have.
 * Health Connect stays the source for `health_metrics`; these only fill its
 * gaps (see fillHealthMetricsFromGarmin).
 */
export const garminDays = sqliteTable("garmin_days", {
  /** Garmin's calendar date "YYYY-MM-DD" (the watch's local day). */
  day: text("day").primaryKey(),
  steps: integer("steps"),
  caloriesTotal: real("calories_total"),
  caloriesActive: real("calories_active"),
  restingHr: real("resting_hr"),
  minHr: real("min_hr"),
  maxHr: real("max_hr"),
  stressAvg: real("stress_avg"),
  stressMax: real("stress_max"),
  bodyBatteryHigh: real("body_battery_high"),
  bodyBatteryLow: real("body_battery_low"),
  bodyBatteryCharged: real("body_battery_charged"),
  bodyBatteryDrained: real("body_battery_drained"),
  bodyBatteryWake: real("body_battery_wake"),
  respirationAvg: real("respiration_avg"),
  spo2Avg: real("spo2_avg"),
  spo2Low: real("spo2_low"),
  floorsUp: real("floors_up"),
  intensityMinModerate: real("intensity_min_moderate"),
  intensityMinVigorous: real("intensity_min_vigorous"),
  readinessScore: real("readiness_score"),
  readinessLevel: text("readiness_level"),
  trainingStatus: text("training_status"),
  acuteLoad: real("acute_load"),
  chronicLoad: real("chronic_load"),
  hrvLastNight: real("hrv_last_night"),
  hrvWeeklyAvg: real("hrv_weekly_avg"),
  hrvStatus: text("hrv_status"),
  vo2Max: real("vo2_max"),
  weightKg: real("weight_kg"),
  sleepScore: real("sleep_score"),
  sleepStress: real("sleep_stress"),
  sleepRespiration: real("sleep_respiration"),
  /** Body Battery gained overnight. */
  sleepBodyBattery: real("sleep_body_battery"),
  /** Garmin's sleep session id for the night ending this day. */
  sleepId: text("sleep_id"),
  sleepStartedAt: text("sleep_started_at"),
  sleepEndedAt: text("sleep_ended_at"),
  /** Minutes east of UTC where that night was slept. */
  sleepTzOffsetMin: integer("sleep_tz_offset_min"),
  sleepDeepMin: real("sleep_deep_min"),
  sleepRemMin: real("sleep_rem_min"),
  sleepLightMin: real("sleep_light_min"),
  sleepAwakeMin: real("sleep_awake_min"),
  /**
   * The endpoints' answers, verbatim apart from per-minute series (keyed
   * "summary" | "sleep" | "hrv" | "readiness" | "trainingStatus").
   */
  raw: text("raw", { mode: "json" }).$type<Record<string, unknown>>(),
  fetchedAt: text("fetched_at").notNull(),
});
