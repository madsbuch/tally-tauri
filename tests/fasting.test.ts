import { beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { sqlite } from "./testDb";

// Whether an entry breaks a fast is a per-entry mark (fast_ok_note) the
// diary agent or the user sets — no calorie threshold, no spreading by title.
beforeAll(() => {
  sqlite.exec("DELETE FROM food_entries; DELETE FROM fasts;");
});

const db = await import("../src/lib/db");

const meal = (title: string, eatenAt: string, calories: number | null) => ({
  eaten_at: eatenAt,
  title,
  description: null,
  photo_path: null,
  nutrients: calories == null ? {} : { calories },
  model_id: null,
  icon: null,
});

describe("fast-breaking entries", () => {
  test("a fast keeps its purpose", async () => {
    const fast = await db.insertFast(24, "2026-11-08T08:00:00.000Z", "Recoup, 225 kcal is fine");
    expect((await db.getActiveFast())?.purpose).toBe("Recoup, 225 kcal is fine");
    await db.deleteFast(fast.id);
  });

  test("unmarked entries break a fast whatever their calories; marked ones never do", async () => {
    sqlite.exec("DELETE FROM food_entries;");
    const coffee = await db.addFoodEntry(meal("Black coffee", "2026-11-08T09:00:00.000Z", 2));
    await db.addFoodEntry({
      ...meal("Bone broth", "2026-11-08T12:00:00.000Z", 150),
      fast_ok_note: "Within the 225 kcal allowance",
    });

    const since = (await db.listMealsSince("2026-11-08T08:00:00.000Z")).map((m) => m.title);
    expect(since).toEqual(["Black coffee"]);
    expect(await db.getLastMealAt()).toBe("2026-11-08T09:00:00.000Z");

    await db.setFoodEntryFastOk(coffee, "Black coffee");
    expect(await db.listMealsSince("2026-11-08T08:00:00.000Z")).toEqual([]);
    expect(await db.getLastMealAt()).toBeNull();

    await db.clearFastOk(coffee);
    expect(await db.getLastMealAt()).toBe("2026-11-08T09:00:00.000Z");
  });

  test("a mark covers its own entry, not others with the same title", async () => {
    sqlite.exec("DELETE FROM food_entries;");
    const first = await db.addFoodEntry(meal("Fish oil", "2026-11-07T08:00:00.000Z", 9));
    await db.setFoodEntryFastOk(first, "Supplement");
    await db.addFoodEntry(meal("Fish oil", "2026-11-08T08:00:00.000Z", 9));
    const since = await db.listMealsSince("2026-11-07T12:00:00.000Z");
    expect(since.map((m) => m.title)).toEqual(["Fish oil"]);
    expect(since[0]?.fast_ok_note).toBeNull();
  });
});

describe("migration 0030", () => {
  test("keeps past entries reading as they did under the old rules", () => {
    const rust = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
    const all = [...rust.matchAll(/include_str!\("\.\.\/migrations\/([^"]+)"\)/g)].map((m) => m[1]);
    // Everything before 0030, then 0030 itself on top of what that left.
    const at = all.indexOf("0030_fast_purpose.sql");
    expect(at).toBeGreaterThan(0);
    const files = all.slice(0, at);
    const last = all[at];

    const mem = new Database(":memory:");
    const read = (f: string | undefined) =>
      readFileSync(new URL(`../src-tauri/migrations/${f}`, import.meta.url), "utf8");
    for (const f of files) mem.exec(read(f));

    const insert = mem.prepare(
      "INSERT INTO food_entries (eaten_at, title, nutrients, fast_ok_note) VALUES (?, ?, ?, ?)",
    );
    insert.run("2026-11-01T08:00:00Z", "Fish oil", '{"calories":9}', "Supplement");
    insert.run("2026-11-02T08:00:00Z", " fish OIL ", '{"calories":30}', null);
    insert.run("2026-11-02T09:00:00Z", "Black coffee", '{"calories":2}', null);
    insert.run("2026-11-02T12:00:00Z", "Lunch", '{"calories":600}', null);
    insert.run("2026-11-02T15:00:00Z", "Mystery snack", "{}", null);

    mem.exec(read(last));

    const notes = mem
      .query("SELECT title, fast_ok_note AS note FROM food_entries ORDER BY eaten_at")
      .all() as { title: string; note: string | null }[];
    expect(notes.map((n) => n.note)).toEqual([
      "Supplement",
      "Supplement",
      "Under 20 kcal",
      null,
      null,
    ]);
    expect(mem.query("SELECT purpose FROM fasts").all()).toEqual([]);
  });
});
