import { describe, expect, test } from "bun:test";
import {
  cachedShare,
  featureInfo,
  formatUsd,
  groupBy,
  spendOver,
  totalOf,
} from "../src/lib/aiCost";
import type { UsageRow } from "../src/lib/aiCost";

function row(day: string, source: string, model: string, costUsd: number): UsageRow {
  return {
    day,
    source,
    model,
    requests: 2,
    promptTokens: 1000,
    cachedTokens: 250,
    completionTokens: 100,
    costUsd,
  };
}

const rows: UsageRow[] = [
  row("2026-11-01", "coach", "anthropic/claude", 0.3),
  row("2026-11-01", "diary", "google/gemini", 0.05),
  row("2026-11-03", "coach", "google/gemini", 0.1),
  row("2026-11-03", "checkin", "google/gemini", 0.02),
];

describe("cost center roll-ups", () => {
  test("totals add up every row", () => {
    const t = totalOf(rows);
    expect(t.costUsd).toBeCloseTo(0.47);
    expect(t.requests).toBe(8);
    expect(cachedShare(t)).toBeCloseTo(0.25);
  });

  test("groups by feature and by model, most expensive first", () => {
    const features = groupBy(rows, "source");
    expect(features.map((g) => g.key)).toEqual(["coach", "diary", "checkin"]);
    expect(features[0]!.costUsd).toBeCloseTo(0.4);
    const models = groupBy(rows, "model");
    expect(models.map((g) => g.key)).toEqual(["anthropic/claude", "google/gemini"]);
    expect(models[1]!.requests).toBe(6);
  });

  test("daily buckets fill the gaps with zero", () => {
    const b = spendOver(rows, "2026-11-01", "2026-11-04", 1);
    expect(b.map((x) => x.start)).toEqual(["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04"]);
    expect(b.map((x) => Math.round(x.costUsd * 100))).toEqual([35, 0, 12, 0]);
  });

  test("wider buckets end on the last day, the oldest one clipped", () => {
    const b = spendOver(rows, "2026-11-01", "2026-11-05", 2);
    expect(b.map((x) => x.start)).toEqual(["2026-11-01", "2026-11-02", "2026-11-04"]);
    expect(b.map((x) => Math.round(x.costUsd * 100))).toEqual([35, 12, 0]);
  });

  test("labels and amounts read well", () => {
    expect(featureInfo("diary").label).toBe("Photo & food estimates");
    expect(featureInfo("something_new").label).toBe("something_new");
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.004)).toBe("<$0.01");
    expect(formatUsd(1.234)).toBe("$1.23");
  });
});
