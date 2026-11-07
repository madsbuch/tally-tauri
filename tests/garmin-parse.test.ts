import { describe, expect, test } from "bun:test";
import {
  parseGarminCmdError,
  parseGarminDailySummary,
  parseGarminReadiness,
  parseGarminSleep,
  parseGarminSplits,
  parseGarminTrainingStatus,
  parseGarminWeights,
} from "../src/lib/schemas";

describe("Garmin answers", () => {
  test("daily summary: negative sentinels are no data, junk degrades", () => {
    const s = parseGarminDailySummary({
      totalSteps: 8123,
      averageStressLevel: -1,
      bodyBatteryHighestValue: 87,
      restingHeartRate: "48",
    });
    expect(s?.totalSteps).toBe(8123);
    expect(s?.averageStressLevel).toBeNull();
    expect(s?.bodyBatteryHighestValue).toBe(87);
    expect(s?.restingHeartRate).toBeNull();
    expect(parseGarminDailySummary("nope")).toBeNull();
  });

  test("sleep: the night, its local offset, and no per-minute series", () => {
    const end = Date.parse("2026-10-10T05:30:00Z");
    const r = parseGarminSleep({
      dailySleepDTO: {
        id: 987,
        sleepStartTimestampGMT: end - 8 * 3_600_000,
        sleepEndTimestampGMT: end,
        sleepEndTimestampLocal: end + 2 * 3_600_000,
        deepSleepSeconds: 4800,
        sleepScores: { overall: { value: 82 } },
      },
      bodyBatteryChange: 54,
      sleepMovement: [{ x: 1 }],
    });
    expect(r.night?.id).toBe("987");
    expect(r.night?.offsetMin).toBe(120);
    expect(r.night?.deepMin).toBe(80);
    expect(r.score).toBe(82);
    expect(r.bodyBatteryChange).toBe(54);
    expect(r.raw && "sleepMovement" in r.raw).toBe(false);
    expect(parseGarminSleep({ dailySleepDTO: { id: null } }).night).toBeNull();
  });

  test("training status: the primary device, phrase without its suffix", () => {
    const r = parseGarminTrainingStatus({
      mostRecentVO2Max: { generic: { vo2MaxPreciseValue: 52.3, vo2MaxValue: 52 } },
      mostRecentTrainingStatus: {
        latestTrainingStatusData: {
          "1": { trainingStatusFeedbackPhrase: "MAINTAINING_2", primaryTrainingDevice: false },
          "2": {
            trainingStatusFeedbackPhrase: "PRODUCTIVE_3",
            primaryTrainingDevice: true,
            acuteTrainingLoadDTO: { dailyTrainingLoadAcute: 512, dailyTrainingLoadChronic: 430 },
          },
        },
      },
    });
    expect(r.status).toBe("PRODUCTIVE");
    expect(r.acuteLoad).toBe(512);
    expect(r.vo2Max).toBe(52.3);
  });

  test("readiness takes the latest; weights come in grams; laps", () => {
    expect(
      parseGarminReadiness([
        { score: 40, level: "LOW", timestamp: "2026-10-10T05:00:00.0" },
        { score: 71, level: "HIGH", timestamp: "2026-10-10T09:00:00.0" },
      ]),
    ).toEqual({ score: 71, level: "HIGH" });
    expect(
      parseGarminWeights({ dailyWeightSummaries: [{ summaryDate: "2026-10-10", latestWeight: { weight: 81234 } }] })
        .get("2026-10-10"),
    ).toBeCloseTo(81.234);
    const laps = parseGarminSplits({ lapDTOs: [{ distance: 1000, duration: 300, averageHR: 150 }, "bad"] });
    expect(laps).toHaveLength(1);
    expect(laps[0]).toMatchObject({ index: 1, distanceM: 1000, avgHr: 150, avgPower: null });
  });

  test("command errors", () => {
    expect(parseGarminCmdError({ code: "rate_limited", message: "slow down" }).code).toBe("rate_limited");
    expect(parseGarminCmdError("boom")).toEqual({ code: "unknown", message: "boom" });
  });
});
