import { describe, expect, test } from "bun:test";
import {
  parseGarminCmdError,
  parseGarminDailySummary,
  parseGarminReadiness,
  parseGarminDailySummariesV2,
  parseGarminHrvDaily,
  parseGarminLaps,
  parseGarminSleep,
  parseGarminSleepList,
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
    const laps = parseGarminLaps([
      { index: 1, startMs: 1, durationSec: 300, distanceM: 1000, avgHr: 150, maxHr: null, avgSpeedMps: null, avgPower: null, avgCadence: null, elevationGainM: null, calories: null },
      "bad",
    ]);
    expect(laps).toHaveLength(1);
    expect(laps[0]).toMatchObject({ index: 1, distanceM: 1000, avgHr: 150, avgPower: null });
  });

  test("command errors", () => {
    expect(parseGarminCmdError({ code: "rate_limited", message: "slow down" }).code).toBe("rate_limited");
    expect(parseGarminCmdError("boom")).toEqual({ code: "unknown", message: "boom" });
  });

  test("Personal API daily summaries (v2)", () => {
    const m = parseGarminDailySummariesV2({
      data: [
        {
          calendarDate: "2026-11-01",
          movement: { steps: { value: 9876, goal: 10000 }, floorsAscended: { value: 7 } },
          calories: { burnedTotal: 2650, burnedActive: 610 },
          heartRate: { restingValue: 47, minValue: 44, maxValue: 168 },
          stress: { avgLevel: 31, maxLevel: -1 },
          bodyBattery: { maxValue: 92, minValue: 18, chargedValue: 70, drainedValue: 74 },
          pulseOx: { avgValue: 95, minValue: 88 },
          intensityMinutes: { moderate: 20, vigorous: 35 },
        },
        { nope: true },
      ],
    });
    const d = m.get("2026-11-01")!;
    expect(m.size).toBe(1);
    expect(d).toMatchObject({ steps: 9876, floors: 7, caloriesActive: 610, restingHr: 47, stressAvg: 31, stressMax: null, bodyBatteryHigh: 92, spo2Low: 88, intensityVigorous: 35 });
    expect(parseGarminDailySummariesV2("junk").size).toBe(0);
  });

  test("Personal API HRV range and sleep list (string timestamps)", () => {
    const hrv = parseGarminHrvDaily({
      hrvSummaries: [{ calendarDate: "2026-11-01", lastNightAvg: 58, weeklyAvg: 61, status: "BALANCED" }],
    });
    expect(hrv.get("2026-11-01")).toMatchObject({ lastNight: 58, weeklyAvg: 61, status: "BALANCED" });

    const [ms, iso] = parseGarminSleepList([
      {
        id: 1,
        calendarDate: "2026-11-01",
        sleepStartTimestampGMT: "1761946200000",
        sleepEndTimestampGMT: 1761975000000,
        sleepEndTimestampLocal: 1761978600000,
        remSleepSeconds: 5400,
        sleepScores: { overall: { value: 77 } },
      },
      {
        id: 2,
        calendarDate: "2026-11-02",
        sleepStartTimestampGMT: "2026-11-01T22:10:00.0",
        sleepEndTimestampGMT: "2026-11-02T06:10:00.0",
        sleepEndTimestampLocal: "2026-11-02T07:10:00.0",
      },
    ]);
    expect(ms!.night).toMatchObject({ id: "1", startMs: 1761946200000, offsetMin: 60, remMin: 90 });
    expect(ms!.score).toBe(77);
    expect(iso!.night?.startMs).toBe(Date.parse("2026-11-01T22:10:00Z"));
    expect(iso!.night?.offsetMin).toBe(60);
  });
});
