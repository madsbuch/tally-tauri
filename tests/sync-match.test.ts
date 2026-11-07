import { describe, expect, test } from "bun:test";
import { bestSessionMatch, recordIdNames, sameNight, sameSession } from "../src/lib/syncMatch";

const MIN = 60_000;
const at = (startMin: number, lengthMin: number) => ({
  startMs: startMin * MIN,
  endMs: (startMin + lengthMin) * MIN,
});

describe("sameSession", () => {
  test("the same run from both sources", () => {
    expect(sameSession(at(600, 45), at(600, 45))).toBe(true);
    // Seconds apart and trimmed a little in Garmin Connect.
    expect(sameSession(at(600, 45), at(601, 40))).toBe(true);
  });

  test("a different workout the same morning", () => {
    expect(sameSession(at(600, 45), at(660, 30))).toBe(false);
    // Starts close but barely overlaps: a warm-up logged separately.
    expect(sameSession(at(600, 4), at(603, 60))).toBe(false);
  });

  test("a session without a length goes by its start", () => {
    expect(sameSession(at(600, 0), at(601, 30))).toBe(true);
    expect(sameSession(at(600, 0), at(610, 30))).toBe(false);
  });

  test("picks the closest start", () => {
    const a = { id: 1, ...at(598, 40) };
    const b = { id: 2, ...at(600, 40) };
    expect(bestSessionMatch(at(600, 40), [a, b])?.id).toBe(2);
    expect(bestSessionMatch(at(700, 40), [a, b])).toBeNull();
  });
});

describe("sameNight", () => {
  test("the same night with different fall-asleep times", () => {
    expect(sameNight(at(0, 480), at(40, 430))).toBe(true);
  });
  test("an afternoon nap isn't the night", () => {
    expect(sameNight(at(0, 480), at(900, 30))).toBe(false);
  });
});

describe("recordIdNames", () => {
  test("whole digit runs only", () => {
    expect(recordIdNames("17239648123", "17239648123")).toBe(true);
    expect(recordIdNames("garmin_17239648123_run", "17239648123")).toBe(true);
    expect(recordIdNames("917239648123", "17239648123")).toBe(false);
    expect(recordIdNames(null, "17239648123")).toBe(false);
    expect(recordIdNames("abc", "garmin:1")).toBe(false);
  });
});
