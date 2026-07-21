import { useEffect, useMemo, useState } from "react";
import type { NutrientKey, Nutrients, Supplement, SupplementLogWithSupplement } from "../lib/types";
import { DEFAULT_VISION_MODEL, SETTING_KEYS } from "../lib/types";
import { NUTRIENT_DEFS, formatAmount, omegaRatio, scaleNutrients, sumNutrients } from "../lib/nutrients";
import {
  addSupplement,
  addSupplementLog,
  deleteSupplement,
  deleteSupplementLog,
  getSetting,
  listSupplementLogsForDay,
  listSupplements,
  todayStr,
  updateSupplement,
} from "../lib/db";
import { analyzeSupplement } from "../lib/openrouter";
import NutrientTable from "../components/NutrientTable";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const COMMON_KEYS: NutrientKey[] = [
  "creatine_g",
  "sodium_mg",
  "potassium_mg",
  "calcium_mg",
  "magnesium_mg",
  "zinc_mg",
  "iron_mg",
  "selenium_ug",
  "iodine_ug",
  "vitamin_d_ug",
  "vitamin_c_mg",
  "vitamin_b12_ug",
  "omega3_g",
  "omega6_g",
  "caffeine_mg",
];

const COMMON_SET = new Set<NutrientKey>(COMMON_KEYS);

const COMMON_DEFS = COMMON_KEYS.map((k) => NUTRIENT_DEFS.find((d) => d.key === k)!);
const EXTRA_DEFS = NUTRIENT_DEFS.filter((d) => !COMMON_SET.has(d.key));

const DOSE_UNITS = ["mg", "µg", "g", "IU", "ml", "capsule", "tablet", "drop"];

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Shift a "YYYY-MM-DD" local day by `delta` days. */
function shiftDay(day: string, delta: number): string {
  const [y = 0, m = 1, d = 1] = day.split("-").map(Number);
  return todayStr(new Date(y, m - 1, d + delta));
}

function dayLabel(day: string): string {
  const today = todayStr();
  if (day === today) return "Today";
  if (day === shiftDay(today, -1)) return "Yesterday";
  const [y = 0, m = 1, d = 1] = day.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/** Timestamp for a "take now" action: now for today, local noon for past days. */
function takenAtIsoFor(day: string): string {
  if (day === todayStr()) return new Date().toISOString();
  const [y = 0, m = 1, d = 1] = day.split("-").map(Number);
  return new Date(y, m - 1, d, 12, 0, 0).toISOString();
}

/** Compact number for display / input prefill (trims float noise). */
function fmtNum(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

function doseText(dose_amount: number | null, dose_unit: string | null): string | null {
  if (dose_amount == null) return null;
  return `${fmtNum(dose_amount)}${dose_unit ? ` ${dose_unit}` : ""}`;
}

function logDoseText(l: SupplementLogWithSupplement): string {
  const dose = doseText(l.dose_amount, l.dose_unit);
  return dose ? `${fmtNum(l.amount)} × ${dose}` : `× ${fmtNum(l.amount)}`;
}

// ---------------------------------------------------------------------------
// Small presentational helpers
// ---------------------------------------------------------------------------

function TopNutrientChips({ nutrients }: { nutrients: Nutrients }) {
  const present = NUTRIENT_DEFS.filter((d) => nutrients[d.key] != null).slice(0, 3);
  if (present.length === 0) return null;
  return (
    <div className="chips" style={{ marginTop: 6 }}>
      {present.map((d) => (
        <span key={d.key} className="chip">
          <span className="faint">{d.label}</span>
          {formatAmount(d.key, nutrients[d.key]!)}
        </span>
      ))}
    </div>
  );
}

function NutrientInputGrid({
  defs,
  values,
  onChange,
}: {
  defs: typeof NUTRIENT_DEFS;
  values: Partial<Record<NutrientKey, string>>;
  onChange: (key: NutrientKey, value: string) => void;
}) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
      {defs.map((def) => (
        <div key={def.key}>
          <label className="label" htmlFor={`nutrient-${def.key}`}>
            {def.label} ({def.unit})
          </label>
          <input
            id={`nutrient-${def.key}`}
            className="input"
            type="number"
            min={0}
            step="any"
            inputMode="decimal"
            placeholder="—"
            value={values[def.key] ?? ""}
            onChange={(e) => onChange(def.key, e.target.value)}
          />
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Editor bottom sheet (shared add / edit)
// ---------------------------------------------------------------------------

function SupplementEditor({
  supplement,
  onClose,
  onChanged,
}: {
  /** null = create a new supplement. */
  supplement: Supplement | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [name, setName] = useState(supplement?.name ?? "");
  const [doseAmount, setDoseAmount] = useState(
    supplement?.dose_amount != null ? fmtNum(supplement.dose_amount) : "",
  );
  const [doseUnit, setDoseUnit] = useState(supplement?.dose_unit ?? "mg");
  const [notes, setNotes] = useState(supplement?.notes ?? "");
  const [values, setValues] = useState<Partial<Record<NutrientKey, string>>>(() => {
    const out: Partial<Record<NutrientKey, string>> = {};
    if (supplement) {
      for (const [k, v] of Object.entries(supplement.nutrients) as [NutrientKey, number][]) {
        out[k] = fmtNum(v);
      }
    }
    return out;
  });
  const [showAll, setShowAll] = useState(() =>
    supplement
      ? Object.keys(supplement.nutrients).some((k) => !COMMON_SET.has(k as NutrientKey))
      : false,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  const units = DOSE_UNITS.includes(doseUnit) ? DOSE_UNITS : [doseUnit, ...DOSE_UNITS];

  function setVal(key: NutrientKey, value: string) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  function collectNutrients(): Nutrients {
    const out: Nutrients = {};
    for (const def of NUTRIENT_DEFS) {
      const raw = (values[def.key] ?? "").trim();
      if (raw === "") continue;
      const num = parseFloat(raw);
      if (isFinite(num) && num >= 0) out[def.key] = num;
    }
    return out;
  }

  async function handleEstimate() {
    const trimmed = name.trim();
    if (!trimmed) {
      setAiError("Enter a supplement name first.");
      return;
    }
    setAiLoading(true);
    setAiError(null);
    try {
      const apiKey = await getSetting(SETTING_KEYS.openrouterApiKey);
      if (!apiKey) {
        setAiError("Add your OpenRouter API key in Settings first");
        return;
      }
      const model = (await getSetting(SETTING_KEYS.visionModel)) || DEFAULT_VISION_MODEL;
      const dose = doseAmount.trim() ? `, dose: ${doseAmount.trim()} ${doseUnit}` : "";
      const result = await analyzeSupplement(apiKey, model, `${trimmed}${dose}`);
      setValues((prev) => {
        const next = { ...prev };
        for (const [k, v] of Object.entries(result.nutrients) as [NutrientKey, number][]) {
          next[k] = fmtNum(v);
        }
        return next;
      });
      if (Object.keys(result.nutrients).some((k) => !COMMON_SET.has(k as NutrientKey))) {
        setShowAll(true);
      }
      if (result.notes.trim()) {
        setNotes((prev) => (prev.trim() ? `${prev.trim()}\n${result.notes.trim()}` : result.notes.trim()));
      }
    } catch (e) {
      setAiError(errMsg(e));
    } finally {
      setAiLoading(false);
    }
  }

  async function handleSave() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Name is required.");
      return;
    }
    const amt = parseFloat(doseAmount);
    const dose_amount = doseAmount.trim() !== "" && isFinite(amt) && amt > 0 ? amt : null;
    setSaving(true);
    setError(null);
    try {
      const base = {
        name: trimmed,
        dose_amount,
        dose_unit: doseUnit || null,
        nutrients: collectNutrients(),
        notes: notes.trim() ? notes.trim() : null,
      };
      if (supplement) {
        await updateSupplement({ ...supplement, ...base });
      } else {
        await addSupplement({ ...base, archived: 0 });
      }
      onChanged();
      onClose();
    } catch (e) {
      setError(errMsg(e));
      setSaving(false);
    }
  }

  async function handleToggleArchived() {
    if (!supplement) return;
    setSaving(true);
    setError(null);
    try {
      await updateSupplement({ ...supplement, archived: supplement.archived ? 0 : 1 });
      onChanged();
      onClose();
    } catch (e) {
      setError(errMsg(e));
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!supplement) return;
    if (!window.confirm(`Delete "${supplement.name}"? This also removes all of its logs.`)) return;
    setSaving(true);
    setError(null);
    try {
      await deleteSupplement(supplement.id);
      onChanged();
      onClose();
    } catch (e) {
      setError(errMsg(e));
      setSaving(false);
    }
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        <h2 className="sheet-title">{supplement ? "Edit supplement" : "Add supplement"}</h2>

        <div className="field">
          <label className="label" htmlFor="sup-name">
            Name
          </label>
          <input
            id="sup-name"
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Magnesium citrate"
          />
        </div>

        <div className="field">
          <span className="label">Default dose</span>
          <div className="input-row">
            <input
              className="input"
              type="number"
              min={0}
              step="any"
              inputMode="decimal"
              placeholder="e.g. 500"
              value={doseAmount}
              onChange={(e) => setDoseAmount(e.target.value)}
              aria-label="Dose amount"
            />
            <select
              className="input"
              value={doseUnit}
              onChange={(e) => setDoseUnit(e.target.value)}
              aria-label="Dose unit"
            >
              {units.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="field">
          <label className="label" htmlFor="sup-notes">
            Notes
          </label>
          <textarea
            id="sup-notes"
            className="input"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Optional — brand, form, assumptions…"
          />
        </div>

        <div className="section-title" style={{ marginTop: 4 }}>
          Nutrients per dose
        </div>
        <div style={{ marginBottom: 10 }}>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => void handleEstimate()}
            disabled={aiLoading || saving}
          >
            {aiLoading ? (
              <>
                <span className="spinner" style={{ width: 14, height: 14 }} />
                Estimating…
              </>
            ) : (
              "✨ Estimate with AI"
            )}
          </button>
        </div>
        {aiError && (
          <div className="error-text" style={{ marginBottom: 10 }}>
            {aiError}
          </div>
        )}

        <NutrientInputGrid defs={COMMON_DEFS} values={values} onChange={setVal} />
        {showAll && (
          <div style={{ marginTop: 8 }}>
            <NutrientInputGrid defs={EXTRA_DEFS} values={values} onChange={setVal} />
          </div>
        )}
        <div style={{ marginTop: 8 }}>
          <button className="btn btn-ghost btn-sm" onClick={() => setShowAll((v) => !v)}>
            {showAll ? "Hide extra nutrients" : "All nutrients"}
          </button>
        </div>

        {error && (
          <div className="error-text" style={{ marginTop: 12 }}>
            {error}
          </div>
        )}

        <div style={{ marginTop: 16 }}>
          <button
            className="btn btn-primary btn-block"
            onClick={() => void handleSave()}
            disabled={saving}
          >
            {saving ? "Saving…" : supplement ? "Save changes" : "Add supplement"}
          </button>
          <div className="btn-row" style={{ marginTop: 8 }}>
            <button className="btn btn-ghost" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            {supplement && (
              <button
                className="btn btn-ghost"
                onClick={() => void handleToggleArchived()}
                disabled={saving}
              >
                {supplement.archived ? "Unarchive" : "Archive"}
              </button>
            )}
            {supplement && (
              <button
                className="btn btn-danger"
                onClick={() => void handleDelete()}
                disabled={saving}
              >
                Delete
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function SupplementsPage() {
  const [day, setDay] = useState(() => todayStr());
  const [supplements, setSupplements] = useState<Supplement[] | null>(null);
  const [logs, setLogs] = useState<SupplementLogWithSupplement[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [takingId, setTakingId] = useState<number | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [editor, setEditor] = useState<{ supplement: Supplement | null } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [sups, dayLogs] = await Promise.all([
          listSupplements(true),
          listSupplementLogsForDay(day),
        ]);
        if (cancelled) return;
        setSupplements(sups);
        setLogs(dayLogs);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(errMsg(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [day, reloadKey]);

  const refresh = () => setReloadKey((k) => k + 1);

  const isToday = day === todayStr();
  const loading = supplements === null || logs === null;

  const totals = useMemo(
    () => sumNutrients((logs ?? []).map((l) => scaleNutrients(l.nutrients, l.amount))),
    [logs],
  );
  const ratio = omegaRatio(totals);

  const active = (supplements ?? []).filter((s) => !s.archived);
  const archived = (supplements ?? []).filter((s) => s.archived);

  function goDay(delta: number) {
    const next = shiftDay(day, delta);
    if (next > todayStr()) return;
    setDay(next);
    setLogs(null);
  }

  async function handleTake(s: Supplement) {
    setTakingId(s.id);
    try {
      await addSupplementLog(s.id, 1, takenAtIsoFor(day));
      refresh();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setTakingId(null);
    }
  }

  async function handleDeleteLog(log: SupplementLogWithSupplement) {
    if (!window.confirm(`Remove this ${log.name} log?`)) return;
    try {
      await deleteSupplementLog(log.id);
      refresh();
    } catch (e) {
      setError(errMsg(e));
    }
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1 className="page-title">Supplements</h1>
      </header>

      <div className="day-nav">
        <button className="btn btn-sm" onClick={() => goDay(-1)} aria-label="Previous day">
          ‹
        </button>
        <div className="day-nav-title">{dayLabel(day)}</div>
        <button
          className="btn btn-sm"
          onClick={() => goDay(1)}
          disabled={isToday}
          aria-label="Next day"
        >
          ›
        </button>
      </div>

      {error && (
        <div className="error-text" style={{ marginBottom: 10 }}>
          {error}
        </div>
      )}

      {loading ? (
        <div className="empty">
          <div className="spinner" style={{ margin: "0 auto" }} />
        </div>
      ) : (
        <>
          <div className="card">
            <div className="card-title">{isToday ? "Today's intake" : `Intake · ${dayLabel(day)}`}</div>
            {logs.length === 0 ? (
              <div className="empty">
                <div className="empty-icon">💊</div>
                Nothing logged {isToday ? "yet today" : "this day"}.
              </div>
            ) : (
              <>
                {ratio != null && (
                  <div className="chips" style={{ marginBottom: 8 }}>
                    <span className={`chip ${ratio <= 4 ? "chip-accent" : "chip-warn"}`}>
                      Ω6:Ω3 {ratio.toFixed(1)}:1
                    </span>
                  </div>
                )}
                <NutrientTable nutrients={totals} />
              </>
            )}
          </div>

          {logs.length > 0 && (
            <>
              <div className="section-title">Logged</div>
              <div className="list">
                {logs.map((log) => (
                  <div key={log.id} className="list-row">
                    <div className="row-main">
                      <div className="row-title">{log.name}</div>
                      <div className="row-sub">
                        {new Date(log.taken_at).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                        {" · "}
                        {logDoseText(log)}
                      </div>
                    </div>
                    <button
                      className="btn btn-ghost btn-sm"
                      aria-label={`Delete ${log.name} log`}
                      onClick={() => void handleDeleteLog(log)}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}

          <div className="section-title">My supplements</div>
          {active.length === 0 ? (
            <div className="empty">
              <div className="empty-icon">🧴</div>
              No supplements yet. Add one to start logging.
            </div>
          ) : (
            <div className="list">
              {active.map((s) => (
                <div
                  key={s.id}
                  className="list-row"
                  role="button"
                  tabIndex={0}
                  onClick={() => setEditor({ supplement: s })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") setEditor({ supplement: s });
                  }}
                  style={{ cursor: "pointer" }}
                >
                  <div className="row-main">
                    <div className="row-title">{s.name}</div>
                    <div className="row-sub">{doseText(s.dose_amount, s.dose_unit) ?? "No default dose"}</div>
                    <TopNutrientChips nutrients={s.nutrients} />
                  </div>
                  <button
                    className="btn btn-primary btn-sm"
                    disabled={takingId === s.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleTake(s);
                    }}
                  >
                    {takingId === s.id ? (
                      <span className="spinner" style={{ width: 14, height: 14 }} />
                    ) : (
                      "+ Take"
                    )}
                  </button>
                </div>
              ))}
            </div>
          )}

          <div style={{ marginTop: 10 }}>
            <button className="btn btn-block" onClick={() => setEditor({ supplement: null })}>
              + Add supplement
            </button>
          </div>

          {archived.length > 0 && (
            <>
              <div style={{ marginTop: 14, textAlign: "center" }}>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => setShowArchived((v) => !v)}
                >
                  {showArchived ? "Hide archived" : `Show archived (${archived.length})`}
                </button>
              </div>
              {showArchived && (
                <div className="list" style={{ marginTop: 8 }}>
                  {archived.map((s) => (
                    <div
                      key={s.id}
                      className="list-row"
                      role="button"
                      tabIndex={0}
                      onClick={() => setEditor({ supplement: s })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") setEditor({ supplement: s });
                      }}
                      style={{ cursor: "pointer" }}
                    >
                      <div className="row-main">
                        <div className="row-title muted">{s.name}</div>
                        <div className="row-sub">
                          {doseText(s.dose_amount, s.dose_unit) ?? "No default dose"}
                        </div>
                      </div>
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          void (async () => {
                            try {
                              await updateSupplement({ ...s, archived: 0 });
                              refresh();
                            } catch (err) {
                              setError(errMsg(err));
                            }
                          })();
                        }}
                      >
                        Unarchive
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </>
      )}

      {editor && (
        <SupplementEditor
          supplement={editor.supplement}
          onClose={() => setEditor(null)}
          onChanged={refresh}
        />
      )}
    </div>
  );
}
