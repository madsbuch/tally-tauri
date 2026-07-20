import { useEffect, useMemo, useRef, useState } from "react";
import type {
  FoodEntry,
  NutrientKey,
  Nutrients,
  SupplementLogWithSupplement,
} from "../lib/types";
import { DEFAULT_VISION_MODEL, SETTING_KEYS } from "../lib/types";
import {
  NUTRIENT_DEFS,
  NUTRIENT_KEYS,
  scaleNutrients,
  sumNutrients,
} from "../lib/nutrients";
import {
  addFoodEntry,
  deleteFoodEntry,
  getSetting,
  listFoodEntriesForDay,
  listSupplementLogsForDay,
  todayStr,
  updateFoodEntry,
} from "../lib/db";
import { analyzeFood } from "../lib/openrouter";
import { compressImage, deletePhoto, photoSrc, savePhoto } from "../lib/photos";
import NutrientTable, { MacroChips } from "../components/NutrientTable";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_KEYS: NutrientKey[] = ["calories", "protein_g", "carbs_g", "fat_g"];

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

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

function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function nowHhMm(): string {
  const n = new Date();
  return `${String(n.getHours()).padStart(2, "0")}:${String(n.getMinutes()).padStart(2, "0")}`;
}

function numToInput(v: number): string {
  return String(Math.round(v * 100) / 100);
}

/** Resolves a stored photo filename to a displayable <img>. */
function PhotoImg({
  filename,
  className,
  alt,
}: {
  filename: string;
  className: string;
  alt: string;
}) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    photoSrc(filename)
      .then((s) => {
        if (alive) setSrc(s);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [filename]);
  if (!src) return <div className={className} />;
  return <img src={src} className={className} alt={alt} />;
}

function ConfidenceChip({ level }: { level: "low" | "medium" | "high" }) {
  const cls =
    level === "high" ? "chip chip-accent" : level === "low" ? "chip chip-warn" : "chip";
  return <span className={cls}>{level} confidence</span>;
}

// ---------------------------------------------------------------------------
// Entry detail sheet
// ---------------------------------------------------------------------------

function EntryDetailSheet({
  entry,
  onClose,
  onChanged,
}: {
  entry: FoodEntry;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [title, setTitle] = useState(entry.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = title.trim();
  const changed = trimmed.length > 0 && trimmed !== entry.title;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await updateFoodEntry({ ...entry, title: trimmed });
      onChanged();
      onClose();
    } catch (err) {
      setError(errMsg(err));
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm(`Delete "${entry.title}"? This cannot be undone.`)) return;
    setBusy(true);
    setError(null);
    try {
      await deleteFoodEntry(entry.id);
      if (entry.photo_path) await deletePhoto(entry.photo_path);
      onChanged();
      onClose();
    } catch (err) {
      setError(errMsg(err));
      setBusy(false);
    }
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        {entry.photo_path && (
          <div style={{ marginBottom: 12 }}>
            <PhotoImg filename={entry.photo_path} className="photo-full" alt={entry.title} />
          </div>
        )}
        <div className="field">
          <label className="label">Title</label>
          <input
            className="input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Meal title"
          />
        </div>
        <div className="muted small" style={{ marginBottom: 8 }}>
          {timeOf(entry.eaten_at)}
          {entry.model_id ? ` · estimated by ${entry.model_id}` : " · manual entry"}
        </div>
        {entry.description && (
          <div className="muted small" style={{ marginBottom: 8 }}>
            {entry.description}
          </div>
        )}
        <NutrientTable nutrients={entry.nutrients} />
        {error && (
          <div className="error-text" style={{ marginTop: 10 }}>
            {error}
          </div>
        )}
        <div className="btn-row" style={{ marginTop: 16 }}>
          <button className="btn btn-danger" onClick={remove} disabled={busy}>
            Delete
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy || !changed}>
            {busy ? <span className="spinner" /> : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add-meal sheet
// ---------------------------------------------------------------------------

function AddMealSheet({
  day,
  onClose,
  onSaved,
}: {
  day: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [step, setStep] = useState<"capture" | "edit">("capture");
  const [photo, setPhoto] = useState<{ dataUrl: string; base64: string } | null>(null);
  const [note, setNote] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState<string | null>(null);
  const [confidence, setConfidence] = useState<"low" | "medium" | "high" | null>(null);
  const [modelId, setModelId] = useState<string | null>(null);
  const [time, setTime] = useState(() => nowHhMm());
  const [nutrVals, setNutrVals] = useState<Partial<Record<NutrientKey, string>>>({});
  const [pinned, setPinned] = useState<NutrientKey[]>(BASE_KEYS);
  const [showAllN, setShowAllN] = useState(false);
  const [saving, setSaving] = useState(false);

  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError(null);
    try {
      setPhoto(await compressImage(file));
    } catch (err) {
      setError(`Could not read the image: ${errMsg(err)}`);
    }
  }

  async function analyze() {
    setError(null);
    if (!photo && !note.trim()) {
      setError("Add a photo or a note first.");
      return;
    }
    setAnalyzing(true);
    try {
      const apiKey = await getSetting(SETTING_KEYS.openrouterApiKey);
      if (!apiKey) {
        setError("Add your OpenRouter API key in Settings first");
        return;
      }
      const model = (await getSetting(SETTING_KEYS.visionModel)) ?? DEFAULT_VISION_MODEL;
      const res = await analyzeFood({
        apiKey,
        model,
        imageDataUrl: photo?.dataUrl,
        hint: note.trim() || undefined,
      });
      setTitle(res.title);
      setDescription(res.description || null);
      setConfidence(res.confidence);
      setModelId(model);
      const vals: Partial<Record<NutrientKey, string>> = {};
      for (const k of NUTRIENT_KEYS) {
        const v = res.nutrients[k];
        if (v != null) vals[k] = numToInput(v);
      }
      setNutrVals(vals);
      setPinned(
        NUTRIENT_KEYS.filter((k) => BASE_KEYS.includes(k) || res.nutrients[k] != null),
      );
      setStep("edit");
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setAnalyzing(false);
    }
  }

  function skipAi() {
    setError(null);
    setStep("edit");
  }

  async function save() {
    const t = title.trim();
    if (!t) {
      setError("Give the meal a title.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const nutrients: Nutrients = {};
      for (const k of NUTRIENT_KEYS) {
        const raw = (nutrVals[k] ?? "").trim();
        if (!raw) continue;
        const num = parseFloat(raw);
        if (isFinite(num) && num >= 0) nutrients[k] = num;
      }
      let photoPath: string | null = null;
      if (photo) photoPath = await savePhoto(photo.base64);

      const [y, m, d] = day.split("-").map(Number);
      let hh: number;
      let mm: number;
      const parsed = /^(\d{1,2}):(\d{2})/.exec(time);
      if (parsed) {
        hh = Number(parsed[1]);
        mm = Number(parsed[2]);
      } else {
        const n = new Date();
        hh = n.getHours();
        mm = n.getMinutes();
      }
      const eatenAt = new Date(y, m - 1, d, hh, mm);

      await addFoodEntry({
        eaten_at: eatenAt.toISOString(),
        title: t,
        description: description ?? (note.trim() || null),
        photo_path: photoPath,
        nutrients,
        model_id: modelId,
      });
      onSaved();
    } catch (err) {
      setError(errMsg(err));
      setSaving(false);
    }
  }

  const shownDefs = NUTRIENT_DEFS.filter((d) => showAllN || pinned.includes(d.key));

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        <h2 className="sheet-title">{step === "capture" ? "Add meal" : "Review meal"}</h2>

        {photo && (
          <div style={{ marginBottom: 12 }}>
            <img src={photo.dataUrl} className="photo-full" alt="Meal preview" />
          </div>
        )}

        {step === "capture" ? (
          <>
            <input
              ref={cameraRef}
              type="file"
              accept="image/*"
              capture="environment"
              style={{ display: "none" }}
              onChange={onPick}
            />
            <input
              ref={galleryRef}
              type="file"
              accept="image/*"
              style={{ display: "none" }}
              onChange={onPick}
            />
            <div className="btn-row" style={{ marginBottom: 12 }}>
              <button className="btn" onClick={() => cameraRef.current?.click()}>
                📷 {photo ? "Retake photo" : "Take photo"}
              </button>
              <button className="btn" onClick={() => galleryRef.current?.click()}>
                🖼 Gallery
              </button>
            </div>
            <div className="field">
              <label className="label">Note (optional)</label>
              <textarea
                className="input"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="e.g. large bowl, ~500 ml"
                rows={2}
              />
            </div>
            {error && (
              <div className="error-text" style={{ marginBottom: 10 }}>
                {error}
              </div>
            )}
            <button
              className="btn btn-primary btn-block"
              onClick={analyze}
              disabled={analyzing || (!photo && !note.trim())}
            >
              {analyzing ? (
                <>
                  <span className="spinner" /> Analyzing…
                </>
              ) : (
                "✨ Analyze with AI"
              )}
            </button>
            <button
              className="btn btn-ghost btn-block"
              style={{ marginTop: 8 }}
              onClick={skipAi}
              disabled={analyzing}
            >
              Skip AI — enter manually
            </button>
          </>
        ) : (
          <>
            {confidence && (
              <div className="chips" style={{ marginBottom: 12 }}>
                <ConfidenceChip level={confidence} />
                {modelId && <span className="chip">{modelId}</span>}
              </div>
            )}
            <div className="field">
              <label className="label">Title</label>
              <input
                className="input"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Chicken salad"
              />
            </div>
            {description && (
              <div className="muted small" style={{ marginBottom: 12 }}>
                {description}
              </div>
            )}
            <div className="field">
              <label className="label">Eaten at</label>
              <input
                className="input"
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
              />
            </div>
            <div className="label" style={{ marginTop: 4 }}>
              Nutrients
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: "8px 10px",
                marginBottom: 8,
              }}
            >
              {shownDefs.map((d) => (
                <div key={d.key}>
                  <div className="faint small" style={{ margin: "0 2px 3px" }}>
                    {d.label} ({d.unit})
                  </div>
                  <input
                    className="input"
                    type="number"
                    min={0}
                    step="any"
                    inputMode="decimal"
                    placeholder="—"
                    value={nutrVals[d.key] ?? ""}
                    onChange={(e) =>
                      setNutrVals((p) => ({ ...p, [d.key]: e.target.value }))
                    }
                  />
                </div>
              ))}
            </div>
            <button
              className="btn btn-ghost btn-sm btn-block"
              onClick={() => setShowAllN((v) => !v)}
            >
              {showAllN ? "Fewer nutrients" : "More nutrients"}
            </button>
            {error && (
              <div className="error-text" style={{ marginTop: 10 }}>
                {error}
              </div>
            )}
            <div className="btn-row" style={{ marginTop: 14 }}>
              <button
                className="btn btn-ghost"
                onClick={() => setStep("capture")}
                disabled={saving}
              >
                Back
              </button>
              <button className="btn btn-primary" onClick={save} disabled={saving}>
                {saving ? (
                  <>
                    <span className="spinner" /> Saving…
                  </>
                ) : (
                  "Save entry"
                )}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Diary page
// ---------------------------------------------------------------------------

export default function DiaryPage() {
  const [day, setDay] = useState(() => todayStr());
  const [entries, setEntries] = useState<FoodEntry[] | null>(null);
  const [suppLogs, setSuppLogs] = useState<SupplementLogWithSupplement[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showTotals, setShowTotals] = useState(false);
  const [detail, setDetail] = useState<FoodEntry | null>(null);
  const [adding, setAdding] = useState(false);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let alive = true;
    setEntries(null);
    setSuppLogs(null);
    setLoadError(null);
    Promise.all([listFoodEntriesForDay(day), listSupplementLogsForDay(day)])
      .then(([e, s]) => {
        if (!alive) return;
        setEntries(e);
        setSuppLogs(s);
      })
      .catch((err) => {
        if (alive) setLoadError(errMsg(err));
      });
    return () => {
      alive = false;
    };
  }, [day, refresh]);

  const totals = useMemo(
    () =>
      sumNutrients([
        ...(entries ?? []).map((e) => e.nutrients),
        ...(suppLogs ?? []).map((l) => scaleNutrients(l.nutrients, l.amount)),
      ]),
    [entries, suppLogs],
  );

  const isToday = day === todayStr();
  const loading = entries === null && loadError === null;
  const bump = () => setRefresh((n) => n + 1);

  return (
    <div className="page">
      <header className="page-header">
        <h1 className="page-title">Diary</h1>
        <span className="page-sub">{day}</span>
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

      <button className="btn btn-primary btn-block" onClick={() => setAdding(true)}>
        + Add meal
      </button>

      {loadError && (
        <div className="error-text" style={{ margin: "14px 2px" }}>
          {loadError}
        </div>
      )}

      {loading && !loadError && (
        <div style={{ display: "flex", justifyContent: "center", padding: 32 }}>
          <span className="spinner" />
        </div>
      )}

      {!loading && !loadError && entries && suppLogs && (
        <>
          <div className="section-title">Daily totals</div>
          <div className="stat-grid">
            <div className="stat">
              <div className="stat-value">{Math.round(totals.calories ?? 0)}</div>
              <div className="stat-label">kcal</div>
            </div>
            <div className="stat">
              <div className="stat-value">{Math.round(totals.protein_g ?? 0)}g</div>
              <div className="stat-label">Protein</div>
            </div>
            <div className="stat">
              <div className="stat-value">{Math.round(totals.carbs_g ?? 0)}g</div>
              <div className="stat-label">Carbs</div>
            </div>
            <div className="stat">
              <div className="stat-value">{Math.round(totals.fat_g ?? 0)}g</div>
              <div className="stat-label">Fat</div>
            </div>
          </div>
          {suppLogs.length > 0 && (
            <div className="faint small" style={{ textAlign: "center", marginTop: 6 }}>
              Includes {suppLogs.length} supplement{" "}
              {suppLogs.length === 1 ? "dose" : "doses"}
            </div>
          )}
          <button
            className="btn btn-ghost btn-sm btn-block"
            style={{ marginTop: 8 }}
            onClick={() => setShowTotals((v) => !v)}
          >
            {showTotals ? "Hide all nutrients" : "Show all nutrients"}
          </button>
          {showTotals && (
            <div className="card" style={{ marginTop: 8 }}>
              <NutrientTable nutrients={totals} />
            </div>
          )}

          <div className="section-title">Meals</div>
          {entries.length === 0 ? (
            <div className="empty">
              <div className="empty-icon">🍽</div>
              No meals logged {isToday ? "yet today" : "this day"}.
            </div>
          ) : (
            <div className="list">
              {entries.map((e) => (
                <div
                  key={e.id}
                  className="list-row"
                  role="button"
                  tabIndex={0}
                  style={{ cursor: "pointer" }}
                  onClick={() => setDetail(e)}
                  onKeyDown={(ev) => {
                    if (ev.key === "Enter") setDetail(e);
                  }}
                >
                  {e.photo_path ? (
                    <PhotoImg filename={e.photo_path} className="photo-thumb" alt={e.title} />
                  ) : (
                    <div
                      className="photo-thumb"
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 22,
                      }}
                    >
                      🍽
                    </div>
                  )}
                  <div className="row-main">
                    <div className="row-title">{e.title}</div>
                    <div className="row-sub">
                      {timeOf(e.eaten_at)}
                      {e.model_id ? " · AI estimate" : " · manual"}
                    </div>
                    <div style={{ marginTop: 6 }}>
                      <MacroChips nutrients={e.nutrients} />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {detail && (
        <EntryDetailSheet
          entry={detail}
          onClose={() => setDetail(null)}
          onChanged={bump}
        />
      )}
      {adding && (
        <AddMealSheet
          day={day}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            bump();
          }}
        />
      )}
    </div>
  );
}
