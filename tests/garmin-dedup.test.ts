import { beforeAll, describe, expect, test } from "bun:test";
import { sqlite } from "./testDb";

// The app's SQL runs in Rust (tauri-plugin-sql); here the same statements run
// against bun:sqlite with every real migration applied, so the dedup logic is
// exercised end to end through the real db.ts / garminDb.ts code.
beforeAll(() => {
  sqlite.exec(
    "DELETE FROM workouts; DELETE FROM garmin_activities; DELETE FROM garmin_days; " +
      "DELETE FROM health_metrics; DELETE FROM sleep_sessions; DELETE FROM settings;",
  );
});

const db = await import("../src/lib/db");
const g = await import("../src/lib/garminDb");
const { parseGarminActivities } = await import("../src/lib/schemas");

const T = Date.parse("2026-10-01T06:00:00.000Z");
const MIN = 60_000;

function activity(id: string, startMs: number, durationMin: number, extra: Record<string, unknown> = {}) {
  const raw = {
    activityId: Number(id),
    activityName: `Run ${id}`,
    beginTimestamp: startMs,
    startTimeGMT: new Date(startMs).toISOString().slice(0, 19).replace("T", " "),
    startTimeLocal: new Date(startMs + 120 * MIN).toISOString().slice(0, 19).replace("T", " "),
    activityType: { typeKey: "running" },
    duration: durationMin * 60,
    calories: 500,
    bmrCalories: 60,
    aerobicTrainingEffect: 3.2,
    activityTrainingLoad: 88,
    hrTimeInZone_2: 1200,
    ...extra,
  };
  const { activities, raws } = parseGarminActivities([raw]);
  return { a: activities[0]!, raw: raws[0]! };
}

async function hcWorkout(id: string, startMs: number, durationMin: number, sourceRecordId: string | null = null, source = "Garmin") {
  await db.upsertExternalWorkout({
    performed_at: new Date(startMs).toISOString(),
    title: "Running",
    description: "Running",
    photo_path: null,
    calories_burned: 400,
    duration_min: durationMin,
    model_id: null,
    icon: null,
    source,
    external_id: id,
    tz_offset_min: 120,
    source_record_id: sourceRecordId,
  });
}

const allWorkouts = () => sqlite.query("SELECT * FROM workouts ORDER BY id").all() as Record<string, unknown>[];

describe("Garmin ↔ Health Connect dedup", () => {
  test("an activity attaches to the Health Connect workout, keeping user edits", async () => {
    await hcWorkout("hc-1", T, 45);
    sqlite.run("UPDATE workouts SET cardio = 1, icon = 'run' WHERE external_id = 'hc-1'");
    const { a, raw } = activity("111", T + 20_000, 44.5);
    expect(await g.linkGarminActivity(a, raw)).toBe("time");
    const ws = allWorkouts();
    expect(ws.length).toBe(1);
    expect(ws[0]!["cardio"]).toBe(1);
    expect(ws[0]!["icon"]).toBe("run");
    const details = await g.garminDetailsForWorkouts([ws[0]!["id"] as number]);
    expect(details.get(ws[0]!["id"] as number)?.aerobicTe).toBe(3.2);
    expect(details.get(ws[0]!["id"] as number)?.zoneSecs).toEqual([0, 1200, 0, 0, 0]);
    // Again: just refreshed.
    expect(await g.linkGarminActivity(a, raw)).toBe("updated");
    expect(allWorkouts().length).toBe(1);
  });

  test("an activity Health Connect lacks gets its own row, which Health Connect later takes over", async () => {
    const start = T + 26 * 60 * MIN;
    const { a, raw } = activity("222", start, 30);
    expect(await g.linkGarminActivity(a, raw)).toBe("created");
    let row = allWorkouts().find((w) => w["external_id"] === "garmin:222")!;
    expect(row["calories_burned"]).toBe(440); // active: 500 − 60 BMR
    expect(row["day"]).toBe("2026-10-02");
    expect(row["tz_offset_min"]).toBe(120);

    await g.adoptGarminWorkout("hc-2", null, { startMs: start + 5_000, endMs: start + 30 * MIN });
    await hcWorkout("hc-2", start + 5_000, 30);
    expect(allWorkouts().length).toBe(2);
    row = allWorkouts().find((w) => w["id"] === row["id"])!;
    expect(row["external_id"]).toBe("hc-2");
    expect(await g.linkGarminActivity(a, raw)).toBe("updated");
    expect(allWorkouts().length).toBe(2);
  });

  test("clientRecordId naming the activity matches exactly, even when times disagree", async () => {
    const start = T + 3 * 24 * 60 * MIN;
    await hcWorkout("hc-3", start + 10 * MIN, 20, "333");
    const { a, raw } = activity("333", start, 20);
    expect(await g.linkGarminActivity(a, raw)).toBe("exact");
    expect(allWorkouts().length).toBe(3);
  });

  test("a deleted workout isn't brought back", async () => {
    const id = allWorkouts().find((w) => w["external_id"] === "hc-1")!["id"] as number;
    await db.deleteWorkout(id);
    const { a, raw } = activity("111", T + 20_000, 44.5);
    expect(await g.linkGarminActivity(a, raw)).toBe("skipped");
    expect(allWorkouts().some((w) => w["id"] === id)).toBe(false);
    expect(allWorkouts().some((w) => w["external_id"] === "garmin:111")).toBe(false);
  });

  test("Health Connect's purge leaves Garmin-linked rows alone", async () => {
    const start = T + 5 * 24 * 60 * MIN;
    await hcWorkout("hc-other", start, 25, null, "Health Connect");
    const { a, raw } = activity("444", start, 25);
    expect(await g.linkGarminActivity(a, raw)).toBe("time");
    await hcWorkout("hc-unlinked", start + 600 * MIN, 25, null, "Health Connect");
    await db.purgeSyncedDataNotFrom("Garmin", "2030-01-01");
    const ids = allWorkouts().map((w) => w["external_id"]);
    expect(ids).toContain("hc-other");
    expect(ids).not.toContain("hc-unlinked");
    expect(ids).toContain("hc-2");
  });

  test("Garmin fills Health Connect's metric gaps without overriding it", async () => {
    await db.upsertHealthMetric({
      day: "2026-10-01",
      steps: 9000,
      resting_hr: null,
      hrv_ms: null,
      spo2_pct: null,
      weight_kg: null,
      vo2_max: null,
      calories_total: 2500,
    });
    const base = { fetchedAt: new Date().toISOString() };
    await g.upsertGarminDay({ day: "2026-10-01", steps: 9100, restingHr: 48, ...base });
    await g.upsertGarminDay({ day: "2026-09-30", steps: 7000, hrvLastNight: 61, ...base });
    await g.fillHealthMetricsFromGarmin();
    const m = await db.listHealthMetricsForRange("2026-09-30", "2026-10-01");
    const oct1 = m.find((r) => r.day === "2026-10-01")!;
    expect(oct1.steps).toBe(9000);
    expect(oct1.resting_hr).toBe(48);
    expect(oct1.calories_total).toBe(2500);
    expect(m.find((r) => r.day === "2026-09-30")?.hrv_ms).toBe(61);
    // Health Connect later has a value: it wins.
    await db.upsertHealthMetric({ ...oct1, resting_hr: 50 });
    await g.fillHealthMetricsFromGarmin();
    const again = await db.listHealthMetricsForRange("2026-10-01", "2026-10-01");
    expect(again[0]!.resting_hr).toBe(50);
  });

  test("a night only Garmin has is added once, then taken over by Health Connect", async () => {
    const start = Date.parse("2026-10-09T21:30:00.000Z");
    const end = Date.parse("2026-10-10T05:30:00.000Z");
    await g.upsertGarminDay({
      day: "2026-10-10",
      sleepId: "s1",
      sleepStartedAt: new Date(start).toISOString(),
      sleepEndedAt: new Date(end).toISOString(),
      sleepTzOffsetMin: 120,
      sleepDeepMin: 80,
      fetchedAt: new Date().toISOString(),
    });
    expect(await g.fillSleepFromGarmin()).toBe(1);
    expect(await g.fillSleepFromGarmin()).toBe(0);
    await g.adoptGarminSleep("hc-night", { startMs: start + 15 * MIN, endMs: end });
    const rows = sqlite.query("SELECT external_id, day FROM sleep_sessions").all() as Record<string, unknown>[];
    expect(rows).toEqual([{ external_id: "hc-night", day: "2026-10-10" }]);
    expect(await g.fillSleepFromGarmin()).toBe(0);
  });

  test("a day's write merges: neither way in blanks out the other's columns", async () => {
    const at = new Date().toISOString();
    await g.upsertGarminDay({ day: "2026-10-20", readinessScore: 70, trainingStatus: "PRODUCTIVE", raw: { readiness: [1] }, fetchedAt: at });
    await g.upsertGarminDay({ day: "2026-10-20", steps: 5000, bodyBatteryHigh: 80, raw: { dailySummary: { a: 1 } }, fetchedAt: at });
    const [row] = sqlite.query("SELECT steps, readiness_score, training_status, body_battery_high FROM garmin_days WHERE day = '2026-10-20'").all() as Record<string, unknown>[];
    expect(row).toMatchObject({ steps: 5000, readiness_score: 70, training_status: "PRODUCTIVE", body_battery_high: 80 });
    const keys = sqlite.query("SELECT key FROM garmin_days, json_each(garmin_days.raw) WHERE day = '2026-10-20' ORDER BY key").all();
    expect(keys).toEqual([{ key: "dailySummary" }, { key: "readiness" }]);
  });

  test("the link report adds up", async () => {
    const r = await g.garminLinkReport();
    expect(r.activities).toBe(4);
    expect(r.exact).toBe(1);
    expect(r.time).toBe(1);
    expect(r.created).toBe(1);
    expect(r.dismissed).toBe(1);
    expect(r.hcWithRecordId).toBe(1);
    expect(r.hcRecordIdExample).toBe("333");
  });
});
