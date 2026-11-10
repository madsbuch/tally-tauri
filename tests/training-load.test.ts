import { beforeAll, describe, expect, test } from "bun:test";
import { sqlite } from "./testDb";
import { TRAINING, loadOf } from "../src/lib/storeModels";

beforeAll(() => {
  sqlite.exec("DELETE FROM garmin_activities; DELETE FROM garmin_days; DELETE FROM workouts;");
});

const body = await import("../src/lib/body");

describe("training load", () => {
  test("a workout counts by Garmin's load, its energy only without one", () => {
    expect(loadOf({ at: 0, durationMin: 60, kcal: 600, zone2Min: null, garminLoad: 145 })).toBe(145);
    expect(loadOf({ at: 0, durationMin: 60, kcal: 600, zone2Min: null, garminLoad: null })).toBe(60);
    expect(loadOf({ at: 0, durationMin: 60, kcal: 600, zone2Min: null })).toBe(60);
  });

  test("the snapshot reads Garmin's loads, and Garmin's own ratio when it has one", async () => {
    const now = new Date("2026-11-10T18:00:00.000Z");
    const day = (d: number) => `2026-${d < 1 ? "10" : "11"}-${String(d < 1 ? 31 + d : d).padStart(2, "0")}`;
    // A run every other day for four weeks: two with Garmin's load, the rest not.
    for (let d = -17; d <= 10; d += 2) {
      const at = `${day(d)}T07:00:00.000Z`;
      const r = sqlite
        .query(
          "INSERT INTO workouts (performed_at, title, calories_burned, duration_min, day, tz_offset_min) VALUES (?, 'Run', 500, 50, ?, 60) RETURNING id",
        )
        .get(at, day(d)) as { id: number };
      if (d >= 6) {
        sqlite
          .query(
            "INSERT INTO garmin_activities (activity_id, workout_id, started_at, training_load, updated_at) VALUES (?, ?, ?, 180, ?)",
          )
          .run(`a${d}`, r.id, at, at);
      }
    }
    const profile = await body.loadProfile();
    let intake = await body.loadIntake(body.intakeStartDay(profile, "2026-11-10"), "2026-11-11");
    expect(intake.workouts.filter((w) => w.garminLoad === 180)).toHaveLength(2);

    let t = body.snapshotOf(intake, profile, now.getTime()).training;
    expect(t.ratioFrom).toBe("model");
    expect(t.garminCounted).toBe(2);
    expect(t.workouts28).toBe(14);
    expect(t.ratio).not.toBeNull();
    // The chart is in Garmin's weekly units.
    expect(t.fitnessSeries.at(-1)).toBeCloseTo(t.fitness * TRAINING.weekly);

    sqlite
      .query(
        "INSERT INTO garmin_days (day, training_status, acute_load, chronic_load, readiness_score, fetched_at) VALUES ('2026-11-09', 'PRODUCTIVE', 600, 400, 71, ?)",
      )
      .run(now.toISOString());
    intake = await body.loadIntake(body.intakeStartDay(profile, "2026-11-10"), "2026-11-11");
    t = body.snapshotOf(intake, profile, now.getTime()).training;
    expect(t.ratioFrom).toBe("garmin");
    expect(t.ratio).toBeCloseTo(1.5);
    expect(t.garmin?.status).toBe("PRODUCTIVE");

    // A week later Garmin's read is stale: back to the model.
    t = body.snapshotOf(intake, profile, new Date("2026-11-17T18:00:00.000Z").getTime()).training;
    expect(t.ratioFrom).toBe("model");
    expect(t.garmin).toBeNull();
  });
});
