import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { DIET, EMPTY_DIET, dietOccasions, dietWeek, summarizeDiet } from "../src/lib/diet";
import { MealChatSchema, ModelDietSchema, parseDietObservations, parseEntrySnapshot } from "../src/lib/schemas";
import type { FoodEntry } from "../src/lib/types";

function meal(id: number, when: string, diet: FoodEntry["diet"] = null, protein?: number): FoodEntry {
  return { id, eaten_at: when, day: when.slice(0, 10), tz_offset_min: 0, title: "Meal", description: null,
    photo_path: null, nutrients: protein == null ? {} : { protein_g: protein }, model_id: null, icon: null, diet };
}
const drink = { ...EMPTY_DIET, alcohol: true, drinks: 1 };

describe("personal diet accounting", () => {
  test("calendar weeks are Monday–Sunday across a year boundary", () => {
    expect(dietWeek("2027-01-03")).toEqual({ start: "2026-12-28", end: "2027-01-03" });
    expect(dietWeek("2027-01-04").start).toBe("2027-01-04");
  });
  test("unknown entries aren't classified as successful or failed meals", () => {
    const s = summarizeDiet([meal(1, "2026-10-26T12:00:00Z")], "2026-10-26");
    expect(s.assessedMeals).toHaveLength(0);
    expect(s.mainMealsUnknown).toBe(1);
    expect(s.candyUnknown).toBe(1);
    expect(s.alcoholUnknown).toBe(1);
    expect(s.proteinUnknown).toBe(1);
    expect(s.loggedDays).toBe(1);
    expect(DIET.proteinG).toBe(150);
  });
  test("protein counts only the selected local day; vegetable denominator excludes snacks and unknowns", () => {
    const entries = [
      meal(1, "2026-10-26T12:00:00Z", { ...EMPTY_DIET, main_meal: true, vegetable_forward: true }, 55),
      meal(2, "2026-10-26T18:00:00Z", { ...EMPTY_DIET, main_meal: true, vegetable_forward: false }, 60),
      meal(3, "2026-10-27T12:00:00Z", { ...EMPTY_DIET, main_meal: false, vegetable_forward: true }, 20),
    ];
    const s = summarizeDiet(entries, "2026-10-26");
    expect(s.proteinG).toBe(115);
    expect(s.assessedMeals).toHaveLength(2);
    expect(s.vegetableMeals).toHaveLength(1);
    entries[0]!.day = "2026-10-25";
    expect(summarizeDiet(entries, "2026-10-26").proteinG).toBe(60);
  });
  test("an evening's drinks form one occasion but quantities add up", () => {
    const entries = [meal(1, "2026-10-30T20:00:00Z", drink), meal(2, "2026-10-30T22:00:00Z", drink), meal(3, "2026-10-31T01:00:00Z", drink)];
    const s = summarizeDiet(entries.reverse(), "2026-10-30");
    expect(s.alcohol).toHaveLength(1);
    expect(s.drinks).toBe(3);
  });
  test("Sunday night continuation isn't charged again on Monday", () => {
    const entries = [meal(1, "2026-10-25T23:00:00Z", drink), meal(2, "2026-10-26T01:00:00Z", drink), meal(3, "2026-10-26T20:00:00Z", drink)];
    expect(summarizeDiet(entries, "2026-10-26").alcohol).toHaveLength(1);
    expect(summarizeDiet(entries, "2026-10-25").drinks).toBe(2);
  });
  test("labels can join distant logs or separate adjacent occasions", () => {
    const entries = [meal(1, "2026-10-30T12:00:00Z", { ...drink, occasion: "Lunch" }), meal(2, "2026-10-30T14:00:00Z", { ...drink, occasion: "Dinner" }), meal(3, "2026-10-30T20:00:00Z", { ...drink, occasion: "Dinner" })];
    expect(dietOccasions(entries, "alcohol").map((g) => g.length)).toEqual([1, 2]);
  });
  test("continuous logging cannot chain occasions indefinitely", () => {
    const entries = Array.from({ length: 6 }, (_, i) => meal(i, `2026-10-30T${String(i * 4).padStart(2, "0")}:00:00Z`, drink));
    expect(dietOccasions(entries, "alcohol").map((g) => g.length)).toEqual([4, 2]);
  });
  test("categories count independently and missing drink quantities remain unknown", () => {
    const s = summarizeDiet([meal(1, "2026-10-30T20:00:00Z", { ...drink, candy: true, drinks: null })], "2026-10-30");
    expect(s.candy).toHaveLength(1);
    expect(s.alcohol).toHaveLength(1);
    expect(s.drinksUnknown).toBe(1);
  });
});

describe("diet persistence and model boundaries", () => {
  test("sloppy model booleans become unknown, not truthy strings", () => {
    expect(ModelDietSchema.parse({ candy: "false", alcohol: false, drinks: -1 })).toEqual({ ...EMPTY_DIET, alcohol: false });
    expect(ModelDietSchema.parse(undefined)).toBeNull();
    expect(() => parseDietObservations('{"candy":"false"}')).toThrow();
  });
  test("entry chat accepts observation-only corrections and preserves omitted diet", () => {
    expect(MealChatSchema.parse({ reply: "Updated", entry: { diet: { candy: true } } }).entry?.diet?.candy).toBe(true);
    expect(MealChatSchema.parse({ reply: "Updated", entry: { title: "Lunch" } }).entry?.diet).toBeUndefined();
  });
  test("undo snapshots preserve observations and older snapshots remain readable", () => {
    const entry = meal(1, "2026-10-30T20:00:00Z", drink);
    expect(parseEntrySnapshot(entry)).toEqual(entry);
    const { diet: _diet, ...legacy } = entry;
    expect(parseEntrySnapshot(legacy)).toEqual({ ...legacy, diet: null });
  });
  test("migration preserves old food and defaults observations to unknown", () => {
    const db = new Database(":memory:");
    db.run("CREATE TABLE food_entries (id INTEGER PRIMARY KEY, title TEXT, nutrients TEXT)");
    db.run("INSERT INTO food_entries VALUES (1, 'Lunch', '{\"protein_g\":42}')");
    db.run(readFileSync(new URL("../src-tauri/migrations/0017_diet_observations.sql", import.meta.url), "utf8"));
    expect(db.query("SELECT * FROM food_entries").get()).toEqual({ id: 1, title: "Lunch", nutrients: '{"protein_g":42}', diet: null });
    db.run("UPDATE food_entries SET diet = ? WHERE id = 1", [JSON.stringify(drink)]);
    const row = db.query<{ diet: string }, []>("SELECT diet FROM food_entries").get();
    expect(parseDietObservations(row?.diet)).toEqual(drink);
    db.close();
  });
});
