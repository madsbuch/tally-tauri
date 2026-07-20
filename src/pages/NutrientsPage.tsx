import { useEffect, useMemo, useState } from "react";
import {
  listFoodEntriesForDay,
  listSupplementLogsForDay,
  listWorkoutsForDay,
  todayStr,
} from "../lib/db";
import {
  NUTRIENT_DEFS,
  formatAmount,
  omegaRatio,
  scaleNutrients,
  sumNutrients,
} from "../lib/nutrients";
import type {
  FoodEntry,
  NutrientKey,
  Nutrients,
  SupplementLogWithSupplement,
  Workout,
} from "../lib/types";

// ---------------------------------------------------------------------------
// Day helpers
// ---------------------------------------------------------------------------

/** Shift a "YYYY-MM-DD" local day string by whole days. */
function shiftDay(day: string, delta: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return todayStr(new Date(y, m - 1, d + delta));
}

function dayTitle(day: string): string {
  const today = todayStr();
  if (day === today) return "Today";
  if (day === shiftDay(today, -1)) return "Yesterday";
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

// ---------------------------------------------------------------------------
// Reference intakes (approximate adult daily reference values)
// ---------------------------------------------------------------------------

const REFERENCE_INTAKES: Partial<Record<NutrientKey, number>> = {
  sodium_mg: 2300,
  potassium_mg: 3400,
  calcium_mg: 1000,
  magnesium_mg: 400,
  iron_mg: 8,
  zinc_mg: 11,
  selenium_ug: 55,
  iodine_ug: 150,
  vitamin_a_ug: 900,
  vitamin_c_mg: 90,
  vitamin_d_ug: 20,
  vitamin_e_mg: 15,
  vitamin_k_ug: 120,
  vitamin_b6_mg: 1.7,
  vitamin_b12_ug: 2.4,
  folate_ug: 400,
  // cholesterol_mg intentionally has no reference — value only.
};

const MACRO_ROW_KEYS: NutrientKey[] = [
  "protein_g",
  "carbs_g",
  "fat_g",
  "saturated_fat_g",
  "fiber_g",
  "sugar_g",
  "omega3_g",
  "omega6_g",
];

const MACRO_SPLIT: { key: NutrientKey; label: string; kcalPerG: number }[] = [
  { key: "protein_g", label: "Protein", kcalPerG: 4 },
  { key: "carbs_g", label: "Carbs", kcalPerG: 4 },
  { key: "fat_g", label: "Fat", kcalPerG: 9 },
];

const HAIRLINE = "1px solid color-mix(in srgb, var(--border) 55%, transparent)";

// ---------------------------------------------------------------------------
// Meter — accent fill on --bg-elev track, ~8px, rounded
// ---------------------------------------------------------------------------

function MeterBar({ pct, warn }: { pct: number; warn?: boolean }) {
  // Cap at 100%; keep a sliver visible for tiny non-zero values.
  const width = pct <= 0 ? 0 : Math.min(100, Math.max(pct, 1.5));
  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        height: 8,
        borderRadius: 999,
        background: "var(--bg-elev)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          width: `${width}%`,
          height: "100%",
          borderRadius: 999,
          background: warn ? "var(--warn)" : "var(--accent)",
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

type Source = "all" | "food" | "supplements";

const SOURCE_OPTIONS: { value: Source; label: string }[] = [
  { value: "all", label: "All" },
  { value: "food", label: "Food only" },
  { value: "supplements", label: "Supplements" },
];

export default function NutrientsPage() {
  const [day, setDay] = useState(() => todayStr());
  const [entries, setEntries] = useState<FoodEntry[] | null>(null);
  const [suppLogs, setSuppLogs] = useState<SupplementLogWithSupplement[] | null>(null);
  const [workouts, setWorkouts] = useState<Workout[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [source, setSource] = useState<Source>("all");

  const isToday = day === todayStr();

  useEffect(() => {
    let cancelled = false;
    setEntries(null);
    setSuppLogs(null);
    setWorkouts(null);
    setLoadError(null);
    Promise.all([
      listFoodEntriesForDay(day),
      listSupplementLogsForDay(day),
      listWorkoutsForDay(day),
    ])
      .then(([food, logs, wos]) => {
        if (cancelled) return;
        setEntries(food);
        setSuppLogs(logs);
        setWorkouts(wos);
      })
      .catch((e) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [day, reloadKey]);

  const loading = !loadError && (!entries || !suppLogs || !workouts);

  const totals = useMemo(() => {
    if (!entries || !suppLogs) return null;
    const food = sumNutrients(entries.map((e) => e.nutrients));
    const supp = sumNutrients(
      suppLogs.map((l) => scaleNutrients(l.nutrients, l.amount)),
    );
    return { food, supp, all: sumNutrients([food, supp]) };
  }, [entries, suppLogs]);

  const filtered: Nutrients =
    totals == null
      ? {}
      : source === "food"
        ? totals.food
        : source === "supplements"
          ? totals.supp
          : totals.all;

  const eatenKcal = totals?.food.calories ?? 0;
  const burnedKcal = (workouts ?? []).reduce((s, w) => s + w.calories_burned, 0);
  const netKcal = eatenKcal - burnedKcal;

  const macroKcal = MACRO_SPLIT.map((m) => (totals?.food[m.key] ?? 0) * m.kcalPerG);
  const macroKcalTotal = macroKcal.reduce((a, b) => a + b, 0);

  const ratio = omegaRatio(filtered);

  const hasAnyData =
    (entries?.length ?? 0) > 0 ||
    (suppLogs?.length ?? 0) > 0 ||
    (workouts?.length ?? 0) > 0;

  const microDefs = NUTRIENT_DEFS.filter((d) => d.group === "micro");

  return (
    <div className="page">
      <header className="page-header">
        <h1 className="page-title">Nutrients</h1>
        <span className="page-sub">Daily overview</span>
      </header>

      <div className="day-nav">
        <button
          className="btn btn-sm"
          onClick={() => setDay((d) => shiftDay(d, -1))}
          aria-label="Previous day"
        >
          ‹
        </button>
        <div className="day-nav-title">{dayTitle(day)}</div>
        <button
          className="btn btn-sm"
          onClick={() => setDay((d) => shiftDay(d, 1))}
          disabled={isToday}
          aria-label="Next day"
        >
          ›
        </button>
      </div>

      {loadError && (
        <div style={{ margin: "14px 2px" }}>
          <div className="error-text" style={{ marginBottom: 10 }}>
            {loadError}
          </div>
          <button className="btn btn-sm" onClick={() => setReloadKey((k) => k + 1)}>
            Retry
          </button>
        </div>
      )}

      {loading && !loadError && (
        <div style={{ display: "flex", justifyContent: "center", padding: 32 }}>
          <span className="spinner" />
        </div>
      )}

      {!loading && !loadError && totals && !hasAnyData && (
        <div className="empty">
          <div className="empty-icon">🥗</div>
          Nothing logged {isToday ? "yet today" : "this day"}.
          <div className="faint small" style={{ marginTop: 4 }}>
            Meals, supplements and workouts will show up here.
          </div>
        </div>
      )}

      {!loading && !loadError && totals && hasAnyData && (
        <>
          {/* Energy — always food + workouts, unaffected by the source filter */}
          <div className="card">
            <div className="card-title">Energy</div>
            <div className="stat-grid" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
              <div className="stat">
                <div className="stat-value">{Math.round(eatenKcal)}</div>
                <div className="stat-label">Eaten kcal</div>
              </div>
              <div className="stat">
                <div className="stat-value">{Math.round(burnedKcal)}</div>
                <div className="stat-label">Burned kcal</div>
              </div>
              <div className="stat">
                <div className="stat-value">{Math.round(netKcal)}</div>
                <div className="stat-label">Net kcal</div>
              </div>
            </div>

            <div style={{ marginTop: 14 }}>
              {MACRO_SPLIT.map((m, i) => {
                const grams = totals.food[m.key] ?? 0;
                const pct =
                  macroKcalTotal > 0
                    ? Math.round((macroKcal[i] / macroKcalTotal) * 100)
                    : 0;
                return (
                  <div
                    key={m.key}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      marginTop: i === 0 ? 0 : 8,
                    }}
                  >
                    <span
                      style={{
                        width: 56,
                        flexShrink: 0,
                        fontSize: 12.5,
                        fontWeight: 600,
                        color: "var(--muted)",
                      }}
                    >
                      {m.label}
                    </span>
                    <MeterBar pct={pct} />
                    <span
                      style={{
                        minWidth: 96,
                        flexShrink: 0,
                        textAlign: "right",
                        fontSize: 12.5,
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      <span style={{ fontWeight: 650 }}>
                        {formatAmount(m.key, grams)}
                      </span>{" "}
                      <span className="faint">· {pct}%</span>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Source filter — recomputes the cards below */}
          <div className="seg" style={{ margin: "12px 0 10px" }}>
            {SOURCE_OPTIONS.map((o) => (
              <button
                key={o.value}
                className={`seg-item${source === o.value ? " seg-item-active" : ""}`}
                onClick={() => setSource(o.value)}
              >
                {o.label}
              </button>
            ))}
          </div>

          {/* Macros */}
          <div className="card">
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
                marginBottom: 8,
              }}
            >
              <div className="card-title" style={{ margin: 0 }}>
                Macros
              </div>
              {ratio != null && (
                <span className={`chip ${ratio <= 4 ? "chip-accent" : "chip-warn"}`}>
                  Ω6:Ω3 {ratio.toFixed(1)}:1
                </span>
              )}
            </div>
            <div className="nutrient-grid">
              {MACRO_ROW_KEYS.map((key) => {
                const def = NUTRIENT_DEFS.find((d) => d.key === key)!;
                const value = filtered[key];
                return (
                  <div key={key} className="nutrient-row">
                    <span className="n-label">{def.label}</span>
                    <span className="n-value">
                      {value != null ? formatAmount(key, value) : "—"}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Micronutrients */}
          <div className="card">
            <div className="card-title">Micronutrients</div>
            {microDefs.map((def, i) => {
              const value = filtered[def.key];
              const ref = REFERENCE_INTAKES[def.key];
              const pct = ref != null && value != null ? (value / ref) * 100 : null;
              const over = def.key === "sodium_mg" && pct != null && pct > 100;
              return (
                <div
                  key={def.key}
                  style={{
                    padding: "7px 0",
                    borderBottom: i === microDefs.length - 1 ? "none" : HAIRLINE,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 8,
                      fontSize: 13,
                    }}
                  >
                    <span style={{ color: "var(--muted)" }}>{def.label}</span>
                    <span
                      style={{
                        fontWeight: 650,
                        fontVariantNumeric: "tabular-nums",
                        color: over ? "var(--warn)" : undefined,
                      }}
                    >
                      {value != null ? formatAmount(def.key, value) : "—"}
                    </span>
                  </div>
                  {ref != null && (
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        marginTop: 5,
                      }}
                    >
                      <MeterBar pct={pct ?? 0} warn={over} />
                      <span
                        style={{
                          minWidth: 40,
                          flexShrink: 0,
                          textAlign: "right",
                          fontSize: 11.5,
                          fontVariantNumeric: "tabular-nums",
                          color: over ? "var(--warn)" : "var(--faint)",
                        }}
                      >
                        {pct != null ? `${Math.round(pct)}%` : "—"}
                      </span>
                    </div>
                  )}
                </div>
              );
            })}
            <div className="faint small" style={{ marginTop: 10 }}>
              Bars compare the day's intake with an approximate adult daily
              reference. Sodium turns amber when over.
            </div>
          </div>
        </>
      )}
    </div>
  );
}
