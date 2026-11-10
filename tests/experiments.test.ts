import { beforeAll, describe, expect, test } from "bun:test";
import { sqlite } from "./testDb";
import type { Experiment, ExperimentTrial } from "../src/lib/types";

beforeAll(() => {
  sqlite.exec(
    "DELETE FROM experiment_trials; DELETE FROM experiments; DELETE FROM food_entries; DELETE FROM fasts;",
  );
});

const db = await import("../src/lib/db");
const ex = await import("../src/lib/experiments");
const { ExperimentDesignSchema } = await import("../src/lib/schemas");

const experiment = (over: Partial<Experiment> = {}): Experiment => ({
  id: 1,
  title: "Refeed",
  hypothesis: "Carbs first makes re-entry easier",
  applies_when: "fasting",
  arms: [
    { key: "A", label: "Carbs first", detail: "" },
    { key: "B", label: "Protein first", detail: "" },
  ],
  measures: [{ key: "energy", label: "Energy", kind: "rating", better: "higher" }],
  assignment: "balanced",
  target_per_arm: 2,
  status: "running",
  conclusion: null,
  manual_id: null,
  created_at: "",
  updated_at: "",
  ended_at: null,
  ...over,
});

let trialId = 0;
const trial = (arm: string, over: Partial<ExperimentTrial> = {}): ExperimentTrial => ({
  id: ++trialId,
  experiment_id: 1,
  arm,
  fast_id: null,
  started_at: "2026-11-01T12:00:00.000Z",
  day: "2026-11-01",
  tz_offset_min: 60,
  ratings: null,
  note: null,
  excluded: false,
  created_at: "",
  updated_at: "",
  ...over,
});

describe("picking the next option", () => {
  test("alternates between two options", () => {
    const e = experiment();
    expect(ex.nextArm(e, []).key).toBe("A");
    expect(ex.nextArm(e, [trial("A")]).key).toBe("B");
    expect(ex.nextArm(e, [trial("A"), trial("B")]).key).toBe("A");
    // Equal counts: the one used longest ago goes next.
    expect(ex.nextArm(e, [trial("B"), trial("A")]).key).toBe("B");
  });

  test("a trial that doesn't count doesn't count toward its option", () => {
    const e = experiment();
    expect(ex.nextArm(e, [trial("A", { excluded: true })]).key).toBe("A");
    expect(ex.isReadyToConclude(e, [trial("A"), trial("A"), trial("B"), trial("B", { excluded: true })])).toBe(false);
    expect(ex.isReadyToConclude(e, [trial("A"), trial("A"), trial("B"), trial("B")])).toBe(true);
  });

  test("a trial is unrated until every rating is given", () => {
    const e = experiment({
      measures: [
        { key: "energy", label: "Energy", kind: "rating", better: "higher" },
        { key: "gut", label: "Gut", kind: "rating", better: "higher" },
      ],
    });
    expect(ex.isUnrated(e, trial("A"))).toBe(true);
    expect(ex.isUnrated(e, trial("A", { ratings: { energy: 4 } }))).toBe(true);
    expect(ex.isUnrated(e, trial("A", { ratings: { energy: 4, gut: 2 } }))).toBe(false);
    expect(ex.isUnrated(e, trial("A", { excluded: true }))).toBe(false);
  });
});

describe("the coach's design", () => {
  test("a sloppy design comes out smaller, not broken", () => {
    const d = ExperimentDesignSchema.parse({
      title: "  How I refeed ",
      hypothesis: "Carbs first",
      applies_when: "sometimes",
      arms: [{ label: "Carbs first", detail: "60 g rice" }, { label: "" }, "junk", { label: "Protein first" }],
      ratings: [{ label: "Gut feel" }, { label: "Gut feel", better: "lower" }, { label: "" }],
      auto: ["refeed_carbs_g", "not_a_metric", "refeed_carbs_g", "sleep_h"],
      target_per_arm: "40",
    });
    expect(d.title).toBe("How I refeed");
    expect(d.applies_when).toBe("none");
    expect(d.arms).toEqual([
      { key: "A", label: "Carbs first", detail: "60 g rice" },
      { key: "B", label: "Protein first", detail: "" },
    ]);
    expect(d.ratings.map((r) => r.key)).toEqual(["gut_feel", "gut_feel_"]);
    expect(d.auto).toEqual(["refeed_carbs_g", "sleep_h"]);
    expect(d.assignment).toBe("balanced");
    expect(d.target_per_arm).toBe(10);
  });
});

describe("fasts open trials", () => {
  test("each finished fast is a trial with the next option, once", async () => {
    const id = await ex.createExperiment({
      title: "Refeed",
      hypothesis: "Carbs first makes re-entry easier",
      applies_when: "fasting",
      arms: experiment().arms,
      measures: [
        { key: "energy", label: "Energy", kind: "rating", better: "higher" },
        { key: "refeed_carbs_g", label: "Refeed carbs", kind: "auto", better: "higher" },
      ],
      assignment: "balanced",
      target_per_arm: 3,
    });

    const f1 = await db.insertFast(24, "2026-11-01T08:00:00.000Z", null);
    const end1 = new Date("2026-11-02T08:00:00.000Z");
    await db.markFastEnded(f1.id, end1.toISOString());
    await ex.openTrialsForFast(f1, end1);
    await ex.openTrialsForFast(f1, end1);

    const f2 = await db.insertFast(24, "2026-11-03T08:00:00.000Z", null);
    const end2 = new Date("2026-11-04T09:00:00.000Z");
    await db.markFastEnded(f2.id, end2.toISOString());
    await ex.openTrialsForFast(f2, end2);

    // Given up after 3 h of a 24 h goal: not a refeed worth testing.
    const f3 = await db.insertFast(24, "2026-11-05T08:00:00.000Z", null);
    const end3 = new Date("2026-11-05T11:00:00.000Z");
    await db.markFastEnded(f3.id, end3.toISOString());
    await ex.openTrialsForFast(f3, end3);

    const trials = await db.listTrials(id);
    expect(trials.map((t) => [t.fast_id, t.arm])).toEqual([
      [f1.id, "A"],
      [f2.id, "B"],
    ]);

    // The refeed is read from the diary: carbs in the first hours after.
    await db.addFoodEntry({
      eaten_at: "2026-11-02T08:30:00.000Z",
      title: "Rice",
      description: null,
      photo_path: null,
      nutrients: { calories: 300, carbs_g: 65, protein_g: 6 },
      model_id: null,
      icon: null,
    });
    await db.addFoodEntry({
      eaten_at: "2026-11-02T15:00:00.000Z",
      title: "Dinner, later",
      description: null,
      photo_path: null,
      nutrients: { calories: 700, carbs_g: 50 },
      model_id: null,
      icon: null,
    });
    const fasts = new Map((await db.listAllFasts()).map((f) => [f.id, f]));
    const metrics = await ex.loadTrialMetrics(trials, fasts);
    const m1 = metrics.get(trials[0]!.id)!;
    expect(m1.refeed_carbs_g).toBe(65);
    expect(m1.fast_h).toBe(24);
    expect(metrics.get(trials[1]!.id)!.refeed_carbs_g).toBeNull();

    // Ratings round-trip through their schema.
    await ex.saveTrial(trials[0]!.id, { ratings: { energy: 4 } });
    expect((await db.getTrial(trials[0]!.id))?.ratings).toEqual({ energy: 4 });

    // A deleted fast takes its trial with it.
    await db.deleteFast(f2.id);
    expect((await db.listTrials(id)).map((t) => t.fast_id)).toEqual([f1.id]);
  });
});
