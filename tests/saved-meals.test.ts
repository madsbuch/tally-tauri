import { describe, expect, test } from "bun:test";
import { MealChatSchema } from "../src/lib/schemas";
import { isSaveLine } from "../src/lib/entryChat";

describe("entry chat save request", () => {
  const parse = (save: unknown) => MealChatSchema.parse({ reply: "ok", save }).save;

  test("absent or falsy means no save", () => {
    expect(MealChatSchema.parse({ reply: "ok" }).save).toBeNull();
    expect(parse(false)).toBeNull();
    expect(parse("")).toBeNull();
    expect(parse([])).toBeNull();
  });

  test("the shapes a yes arrives in", () => {
    expect(parse(true)).toEqual({ name: null });
    expect(parse(" 7-Eleven bolle ")).toEqual({ name: "7-Eleven bolle" });
    expect(parse({ name: "Surdejsbolle" })).toEqual({ name: "Surdejsbolle" });
    expect(parse({})).toEqual({ name: null });
  });

  test("save lines are told apart from entry changes", () => {
    expect(isSaveLine('Saved meal: "Bolle"')).toBe(true);
    expect(isSaveLine('Updated saved meal: "Bolle"')).toBe(true);
    expect(isSaveLine("Calories: 300 kcal → 486 kcal")).toBe(false);
  });
});
