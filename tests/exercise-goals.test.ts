import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { exerciseProgress, zone2Minutes } from "../src/lib/exerciseGoals";
import { shiftDay } from "../src/lib/daystamp";
import { parseEntrySnapshot, WorkoutChatSchema } from "../src/lib/schemas";

const sqlite = new Database(":memory:");
const rust = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
for (const match of rust.matchAll(/include_str!\("\.\.\/migrations\/([^\"]+)"\)/g)) {
  sqlite.exec(readFileSync(new URL(`../src-tauri/migrations/${match[1]}`, import.meta.url), "utf8"));
}
mock.module("@tauri-apps/plugin-sql", () => ({ default: {
  load: async () => ({
    execute: async (sql: string, params: never[]) => sqlite.query(sql).run(...params),
    select: async (sql: string, params: never[]) => sqlite.query(sql).all(...params),
  }),
} }));
const { addWorkout, getWorkout, updateWorkout, upsertExternalWorkout, listWorkoutsForRange, deleteWorkout, getSetting, setSetting } = await import("../src/lib/db");
const workout = {
  performed_at: "2026-10-28T12:00:00Z", title: "Cycling", description: null,
  photo_path: null, calories_burned: 250, duration_min: 60, model_id: null, icon: null,
};
beforeEach(() => { sqlite.exec("DELETE FROM workouts; DELETE FROM settings;"); });
afterAll(() => sqlite.close());

describe("rolling exercise goals", () => {
  test("unknown time never counts; explicit zero stays distinct", () => {
    expect(zone2Minutes(null, 60)).toBeNull();
    expect(zone2Minutes(0, 60)).toBe(0);
    expect(zone2Minutes(-1, 60)).toBeNull();
    expect(zone2Minutes(Infinity, 60)).toBeNull();
    expect(exerciseProgress([
      { duration_min: 60, zone2_min: null },
      { duration_min: 60, zone2_min: 0 },
      { duration_min: 60, zone2_min: 45.5 },
    ], 300)).toEqual({ minutes: 45.5, remaining: 254.5, percent: 45.5 / 300 * 100, unknown: 1 });
  });
  test("over-target totals remain visible and impossible durations are capped", () => {
    expect(zone2Minutes(90, 60)).toBe(60);
    expect(exerciseProgress([{ duration_min: 360, zone2_min: 330 }], 300))
      .toEqual({ minutes: 330, remaining: 0, percent: 100, unknown: 0 });
  });
  test("seven-day boundaries cross DST and exclude the eighth day and future", async () => {
    const end = "2026-10-28";
    expect(shiftDay(end, -6)).toBe("2026-10-22");
    expect(shiftDay(end, -23)).toBe("2026-10-05");
    for (const day of ["2026-10-21", "2026-10-22", "2026-10-28", "2026-10-29"]) {
      await addWorkout({ ...workout, performed_at: `${day}T12:00:00Z`, zone2_min: 30 });
    }
    const rows = await listWorkoutsForRange(shiftDay(end, -6), end);
    expect(rows.map((w) => w.day)).toEqual(["2026-10-28", "2026-10-22"]);
    expect(exerciseProgress(rows, 300).minutes).toBe(60);
  });
  test("manual minutes persist, clear and follow edits to the workout date", async () => {
    const id = await addWorkout({ ...workout, zone2_min: 45 });
    const w = (await getWorkout(id))!;
    expect(w.zone2_min).toBe(45);
    await updateWorkout({ ...w, zone2_min: null, performed_at: "2026-10-20T12:00:00Z" });
    expect((await getWorkout(id))!.zone2_min).toBeNull();
    expect(await listWorkoutsForRange("2026-10-22", "2026-10-28")).toHaveLength(0);
    await deleteWorkout(id);
    expect(await getWorkout(id)).toBeNull();
  });
  test("Garmin re-sync preserves user annotation and deduplicates", async () => {
    const external = { ...workout, source: "Garmin", external_id: "ride-1" };
    await upsertExternalWorkout(external);
    const [w] = await listWorkoutsForRange("2026-10-22", "2026-10-28");
    expect(w!.zone2_min).toBeNull();
    await updateWorkout({ ...w!, zone2_min: 40 });
    await upsertExternalWorkout({ ...external, calories_burned: 300 });
    const rows = await listWorkoutsForRange("2026-10-22", "2026-10-28");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.zone2_min).toBe(40);
    expect(rows[0]!.calories_burned).toBe(300);
  });
  test("target persists and old undo snapshots still load", async () => {
    await setSetting("zone2_weekly_target", "250");
    expect(await getSetting("zone2_weekly_target")).toBe("250");
    const snapshot = parseEntrySnapshot({ ...workout, id: 1, source: null, external_id: null, day: null, tz_offset_min: null });
    expect(snapshot && "zone2_min" in snapshot ? snapshot.zone2_min : undefined).toBeNull();
  });
  test("entry chat distinguishes omitted, cleared and zero minutes", () => {
    expect(WorkoutChatSchema.parse({ reply: "OK", entry: { zone2_min: 0 } }).entry?.zone2_min).toBe(0);
    expect(WorkoutChatSchema.parse({ reply: "OK", entry: { zone2_min: null } }).entry?.zone2_min).toBeNull();
    expect(WorkoutChatSchema.parse({ reply: "OK", entry: { title: "Ride" } }).entry?.zone2_min).toBeUndefined();
  });
});
