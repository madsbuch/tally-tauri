import { useEffect, useMemo, useRef, useState } from "react";
import type {
  FoodEntry,
  NutrientKey,
  Nutrients,
  Supplement,
  SupplementLogWithSupplement,
  Workout,
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
  addSupplement,
  addSupplementLog,
  addWorkout,
  deleteFoodEntry,
  deleteSupplement,
  deleteSupplementLog,
  deleteWorkout,
  getSetting,
  listFoodEntriesForDay,
  listSupplementLogsForDay,
  listSupplements,
  listWorkoutsForDay,
  todayStr,
  updateFoodEntry,
  updateSupplement,
  updateSupplementLog,
  updateWorkout,
} from "../lib/db";
import { analyzeFood, analyzeSupplement, analyzeWorkout } from "../lib/openrouter";
import { compressImage, deletePhoto, photoSrc, savePhoto } from "../lib/photos";
import NutrientTable, { MacroChips } from "../components/NutrientTable";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_KEYS: NutrientKey[] = ["calories", "protein_g", "carbs_g", "fat_g"];

/** Nutrient inputs shown by default in the supplement editor. */
const COMMON_SUPP_KEYS = new Set<NutrientKey>([
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
]);

const DOSE_UNITS = ["mg", "µg", "g", "IU", "ml", "capsule", "tablet", "drop"];

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

function hhmmOf(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function nowHhMm(): string {
  return hhmmOf(new Date().toISOString());
}

/** Combine a local "YYYY-MM-DD" day and an "HH:MM" time into a UTC ISO string. */
function dayTimeToIso(day: string, time: string): string {
  const [y, mo, d] = day.split("-").map(Number);
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
  return new Date(y, mo - 1, d, hh, mm).toISOString();
}

function numToInput(v: number): string {
  return String(Math.round(v * 100) / 100);
}

/** Round-and-format, rendering negatives with a proper minus sign. */
function fmtSignedInt(n: number): string {
  const r = Math.round(n);
  return r < 0 ? `−${-r}` : String(r);
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

/** Emoji glyph in a photo-thumb-sized rounded square. */
function GlyphThumb({ glyph }: { glyph: string }) {
  return (
    <div
      className="photo-thumb"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 22,
      }}
    >
      {glyph}
    </div>
  );
}

function ConfidenceChip({ level }: { level: "low" | "medium" | "high" }) {
  const cls =
    level === "high" ? "chip chip-accent" : level === "low" ? "chip chip-warn" : "chip";
  return <span className={cls}>{level} confidence</span>;
}

/** − / value × dose / + stepper for supplement amounts (step 0.5, min 0.5). */
function AmountStepper({
  value,
  onChange,
  doseAmount,
  doseUnit,
}: {
  value: number;
  onChange: (v: number) => void;
  doseAmount: number | null;
  doseUnit: string | null;
}) {
  const doseTxt =
    doseAmount != null
      ? `× ${numToInput(doseAmount)}${doseUnit ? ` ${doseUnit}` : ""}`
      : value === 1
        ? "dose"
        : "doses";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <button
        className="btn btn-sm"
        onClick={() => onChange(Math.max(0.5, value - 0.5))}
        disabled={value <= 0.5}
        aria-label="Decrease amount"
      >
        −
      </button>
      <div style={{ flex: 1, textAlign: "center", fontWeight: 700 }}>
        {numToInput(value)} <span className="muted small">{doseTxt}</span>
      </div>
      <button
        className="btn btn-sm"
        onClick={() => onChange(value + 0.5)}
        aria-label="Increase amount"
      >
        +
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Meal detail sheet
// ---------------------------------------------------------------------------

function MealDetailSheet({
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
// Workout detail sheet
// ---------------------------------------------------------------------------

function WorkoutDetailSheet({
  workout,
  onClose,
  onChanged,
}: {
  workout: Workout;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [title, setTitle] = useState(workout.title);
  const [calStr, setCalStr] = useState(numToInput(workout.calories_burned));
  const [durStr, setDurStr] = useState(
    workout.duration_min != null ? numToInput(workout.duration_min) : "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const t = title.trim();
    if (!t) {
      setError("Title is required.");
      return;
    }
    const cal = parseFloat(calStr);
    if (!isFinite(cal) || cal < 0) {
      setError("Calories burned must be a number ≥ 0.");
      return;
    }
    const durParsed = parseFloat(durStr);
    const dur =
      durStr.trim() && isFinite(durParsed) && durParsed > 0
        ? Math.round(durParsed)
        : null;
    setBusy(true);
    setError(null);
    try {
      await updateWorkout({
        ...workout,
        title: t,
        calories_burned: Math.round(cal),
        duration_min: dur,
      });
      onChanged();
      onClose();
    } catch (err) {
      setError(errMsg(err));
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm(`Delete "${workout.title}"? This cannot be undone.`)) return;
    setBusy(true);
    setError(null);
    try {
      await deleteWorkout(workout.id);
      if (workout.photo_path) await deletePhoto(workout.photo_path);
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
        {workout.photo_path && (
          <div style={{ marginBottom: 12 }}>
            <PhotoImg
              filename={workout.photo_path}
              className="photo-full"
              alt={workout.title}
            />
          </div>
        )}
        <div className="field">
          <label className="label">Title</label>
          <input
            className="input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Workout title"
          />
        </div>
        <div className="input-row" style={{ marginBottom: 12 }}>
          <div>
            <label className="label">Calories burned</label>
            <input
              className="input"
              type="number"
              min={0}
              step="any"
              inputMode="decimal"
              value={calStr}
              onChange={(e) => setCalStr(e.target.value)}
            />
          </div>
          <div>
            <label className="label">Duration (min)</label>
            <input
              className="input"
              type="number"
              min={0}
              step="any"
              inputMode="decimal"
              placeholder="—"
              value={durStr}
              onChange={(e) => setDurStr(e.target.value)}
            />
          </div>
        </div>
        <div className="muted small" style={{ marginBottom: 8 }}>
          {timeOf(workout.performed_at)}
          {workout.model_id ? ` · imported by ${workout.model_id}` : " · manual entry"}
        </div>
        {workout.description && (
          <div className="muted small" style={{ marginBottom: 8 }}>
            {workout.description}
          </div>
        )}
        {error && (
          <div className="error-text" style={{ marginTop: 10 }}>
            {error}
          </div>
        )}
        <div className="btn-row" style={{ marginTop: 16 }}>
          <button className="btn btn-danger" onClick={remove} disabled={busy}>
            Delete
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy}>
            {busy ? <span className="spinner" /> : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Supplement-log detail sheet
// ---------------------------------------------------------------------------

function SuppLogDetailSheet({
  log,
  onClose,
  onChanged,
}: {
  log: SupplementLogWithSupplement;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [amount, setAmount] = useState(log.amount);
  const [time, setTime] = useState(() => hhmmOf(log.taken_at));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const logDay = todayStr(new Date(log.taken_at));

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await updateSupplementLog(log.id, amount, dayTimeToIso(logDay, time));
      onChanged();
      onClose();
    } catch (err) {
      setError(errMsg(err));
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm(`Delete this ${log.name} dose? This cannot be undone.`)) return;
    setBusy(true);
    setError(null);
    try {
      await deleteSupplementLog(log.id);
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
        <h2 className="sheet-title">💊 {log.name}</h2>
        <div className="muted small" style={{ marginBottom: 12 }}>
          {log.dose_amount != null
            ? `1 dose = ${numToInput(log.dose_amount)}${log.dose_unit ? ` ${log.dose_unit}` : ""}`
            : "Dose size not set"}
        </div>
        <div className="field">
          <label className="label">Amount</label>
          <AmountStepper
            value={amount}
            onChange={setAmount}
            doseAmount={log.dose_amount}
            doseUnit={log.dose_unit}
          />
        </div>
        <div className="field">
          <label className="label">Taken at</label>
          <input
            className="input"
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
          />
        </div>
        <NutrientTable nutrients={scaleNutrients(log.nutrients, amount)} />
        {error && (
          <div className="error-text" style={{ marginTop: 10 }}>
            {error}
          </div>
        )}
        <div className="btn-row" style={{ marginTop: 16 }}>
          <button className="btn btn-danger" onClick={remove} disabled={busy}>
            Delete
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy}>
            {busy ? <span className="spinner" /> : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add-meal sheet (existing flow)
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
    const nutrients: Nutrients = {};
    for (const k of NUTRIENT_KEYS) {
      const raw = (nutrVals[k] ?? "").trim();
      if (!raw) continue;
      const num = parseFloat(raw);
      if (!isFinite(num) || num < 0) {
        const label = NUTRIENT_DEFS.find((d) => d.key === k)?.label ?? k;
        setError(`${label} must be a number ≥ 0.`);
        return;
      }
      nutrients[k] = num;
    }
    setSaving(true);
    setError(null);
    let photoPath: string | null = null;
    try {
      if (photo) photoPath = await savePhoto(photo.base64);

      await addFoodEntry({
        eaten_at: dayTimeToIso(day, time),
        title: t,
        description: description ?? (note.trim() || null),
        photo_path: photoPath,
        nutrients,
        model_id: modelId,
      });
      onSaved();
    } catch (err) {
      if (photoPath) await deletePhoto(photoPath);
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
// Add-workout sheet (mirror of the meal flow)
// ---------------------------------------------------------------------------

function AddWorkoutSheet({
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
  const [calStr, setCalStr] = useState("");
  const [durStr, setDurStr] = useState("");
  const [time, setTime] = useState(() => nowHhMm());
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
      setError("Add a screenshot or a note first.");
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
      const res = await analyzeWorkout({
        apiKey,
        model,
        imageDataUrl: photo?.dataUrl,
        hint: note.trim() || undefined,
      });
      setTitle(res.title);
      setDescription(res.description || null);
      setConfidence(res.confidence);
      setModelId(model);
      setCalStr(numToInput(res.calories_burned));
      setDurStr(res.duration_min != null ? numToInput(res.duration_min) : "");
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
      setError("Give the workout a title.");
      return;
    }
    const cal = parseFloat(calStr);
    if (!isFinite(cal) || cal < 0) {
      setError("Calories burned must be a number ≥ 0.");
      return;
    }
    const durParsed = parseFloat(durStr);
    const dur =
      durStr.trim() && isFinite(durParsed) && durParsed > 0
        ? Math.round(durParsed)
        : null;
    setSaving(true);
    setError(null);
    let photoPath: string | null = null;
    try {
      if (photo) photoPath = await savePhoto(photo.base64);

      await addWorkout({
        performed_at: dayTimeToIso(day, time),
        title: t,
        description: description ?? (note.trim() || null),
        photo_path: photoPath,
        calories_burned: Math.round(cal),
        duration_min: dur,
        model_id: modelId,
      });
      onSaved();
    } catch (err) {
      if (photoPath) await deletePhoto(photoPath);
      setError(errMsg(err));
      setSaving(false);
    }
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        <h2 className="sheet-title">
          {step === "capture" ? "Add workout" : "Review workout"}
        </h2>

        {photo && (
          <div style={{ marginBottom: 12 }}>
            <img src={photo.dataUrl} className="photo-full" alt="Workout screenshot" />
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
                📷 {photo ? "Retake" : "Camera"}
              </button>
              <button className="btn" onClick={() => galleryRef.current?.click()}>
                🖼 Screenshot
              </button>
            </div>
            <div className="field">
              <label className="label">Note (optional)</label>
              <textarea
                className="input"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="e.g. 45 min easy run"
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
                "✨ Import with AI"
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
                placeholder="e.g. Morning run"
              />
            </div>
            {description && (
              <div className="muted small" style={{ marginBottom: 12 }}>
                {description}
              </div>
            )}
            <div className="input-row" style={{ marginBottom: 12 }}>
              <div>
                <label className="label">Calories burned</label>
                <input
                  className="input"
                  type="number"
                  min={0}
                  step="any"
                  inputMode="decimal"
                  placeholder="kcal"
                  value={calStr}
                  onChange={(e) => setCalStr(e.target.value)}
                />
              </div>
              <div>
                <label className="label">Duration (min)</label>
                <input
                  className="input"
                  type="number"
                  min={0}
                  step="any"
                  inputMode="decimal"
                  placeholder="—"
                  value={durStr}
                  onChange={(e) => setDurStr(e.target.value)}
                />
              </div>
            </div>
            <div className="field">
              <label className="label">Performed at</label>
              <input
                className="input"
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
              />
            </div>
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
                  "Save workout"
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
// Supplement editor sheet (new + edit)
// ---------------------------------------------------------------------------

function SupplementEditorSheet({
  initial,
  onClose,
  onSaved,
}: {
  initial: Supplement | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [doseAmount, setDoseAmount] = useState(
    initial?.dose_amount != null ? numToInput(initial.dose_amount) : "1",
  );
  const [doseUnit, setDoseUnit] = useState(initial?.dose_unit ?? "capsule");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [nutrVals, setNutrVals] = useState<Partial<Record<NutrientKey, string>>>(() => {
    const vals: Partial<Record<NutrientKey, string>> = {};
    if (initial) {
      for (const k of NUTRIENT_KEYS) {
        const v = initial.nutrients[k];
        if (v != null) vals[k] = numToInput(v);
      }
    }
    return vals;
  });
  const [showAllN, setShowAllN] = useState(false);
  const [estimating, setEstimating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const unitOptions = DOSE_UNITS.includes(doseUnit)
    ? DOSE_UNITS
    : [doseUnit, ...DOSE_UNITS];

  async function estimate() {
    const n = name.trim();
    if (!n) {
      setError("Give the supplement a name first.");
      return;
    }
    setEstimating(true);
    setError(null);
    try {
      const apiKey = await getSetting(SETTING_KEYS.openrouterApiKey);
      if (!apiKey) {
        setError("Add your OpenRouter API key in Settings first");
        return;
      }
      const model = (await getSetting(SETTING_KEYS.visionModel)) ?? DEFAULT_VISION_MODEL;
      const dose = doseAmount.trim()
        ? `${doseAmount.trim()} ${doseUnit}`.trim()
        : "1 dose";
      const res = await analyzeSupplement(apiKey, model, `${n}, one dose = ${dose}`);
      const vals: Partial<Record<NutrientKey, string>> = {};
      for (const k of NUTRIENT_KEYS) {
        const v = res.nutrients[k];
        if (v != null) vals[k] = numToInput(v);
      }
      setNutrVals(vals);
      if (res.notes && !notes.trim()) setNotes(res.notes);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setEstimating(false);
    }
  }

  async function save(archivedOverride?: number) {
    const n = name.trim();
    if (!n) {
      setError("Name is required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const nutrients: Nutrients = {};
      for (const k of NUTRIENT_KEYS) {
        const raw = (nutrVals[k] ?? "").trim();
        if (!raw) continue;
        const num = parseFloat(raw);
        if (isFinite(num) && num >= 0) nutrients[k] = num;
      }
      const da = parseFloat(doseAmount);
      const record = {
        name: n,
        dose_amount: isFinite(da) && da > 0 ? da : null,
        dose_unit: doseUnit.trim() || null,
        nutrients,
        notes: notes.trim() || null,
        archived: archivedOverride ?? initial?.archived ?? 0,
      };
      if (initial) {
        await updateSupplement({ ...record, id: initial.id });
      } else {
        await addSupplement(record);
      }
      onSaved();
    } catch (err) {
      setError(errMsg(err));
      setBusy(false);
    }
  }

  async function remove() {
    if (!initial) return;
    if (
      !window.confirm(
        `Delete "${initial.name}" and ALL of its logged doses? This cannot be undone.`,
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await deleteSupplement(initial.id);
      onSaved();
    } catch (err) {
      setError(errMsg(err));
      setBusy(false);
    }
  }

  const shownDefs = NUTRIENT_DEFS.filter(
    (d) =>
      showAllN || COMMON_SUPP_KEYS.has(d.key) || (nutrVals[d.key] ?? "").trim() !== "",
  );

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        <h2 className="sheet-title">
          {initial ? "Edit supplement" : "New supplement"}
        </h2>
        <div className="field">
          <label className="label">Name</label>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Magnesium citrate"
          />
        </div>
        <div className="input-row" style={{ marginBottom: 12 }}>
          <div>
            <label className="label">Dose amount</label>
            <input
              className="input"
              type="number"
              min={0}
              step="any"
              inputMode="decimal"
              value={doseAmount}
              onChange={(e) => setDoseAmount(e.target.value)}
            />
          </div>
          <div>
            <label className="label">Unit</label>
            <select
              className="input"
              value={doseUnit}
              onChange={(e) => setDoseUnit(e.target.value)}
            >
              {unitOptions.map((u) => (
                <option key={u} value={u}>
                  {u || "—"}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="field">
          <label className="label">Notes (optional)</label>
          <textarea
            className="input"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g. elemental magnesium per capsule"
            rows={2}
          />
        </div>
        <button
          className="btn btn-block"
          onClick={estimate}
          disabled={estimating || busy || !name.trim()}
        >
          {estimating ? (
            <>
              <span className="spinner" /> Estimating…
            </>
          ) : (
            "✨ Estimate with AI"
          )}
        </button>
        <div className="label" style={{ marginTop: 14 }}>
          Nutrients per dose
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
                onChange={(e) => setNutrVals((p) => ({ ...p, [d.key]: e.target.value }))}
              />
            </div>
          ))}
        </div>
        <button
          className="btn btn-ghost btn-sm btn-block"
          onClick={() => setShowAllN((v) => !v)}
        >
          {showAllN ? "Common nutrients only" : "All nutrients"}
        </button>
        {error && (
          <div className="error-text" style={{ marginTop: 10 }}>
            {error}
          </div>
        )}
        <button
          className="btn btn-primary btn-block"
          style={{ marginTop: 14 }}
          onClick={() => save()}
          disabled={busy || estimating}
        >
          {busy ? (
            <>
              <span className="spinner" /> Saving…
            </>
          ) : (
            "Save supplement"
          )}
        </button>
        {initial && (
          <div className="btn-row" style={{ marginTop: 8 }}>
            <button
              className="btn btn-ghost"
              onClick={() => save(initial.archived ? 0 : 1)}
              disabled={busy || estimating}
            >
              {initial.archived ? "Unarchive" : "Archive"}
            </button>
            <button className="btn btn-danger" onClick={remove} disabled={busy || estimating}>
              Delete
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Supplement picker sheet (log a dose / manage)
// ---------------------------------------------------------------------------

function SupplementSheet({
  day,
  onClose,
  onLogged,
  onMutated,
}: {
  day: string;
  onClose: () => void;
  /** Called after a dose is logged; closes the sheet and refreshes the day. */
  onLogged: () => void;
  /** Called after supplements are edited (keeps the sheet open). */
  onMutated: () => void;
}) {
  const [supps, setSupps] = useState<Supplement[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [manage, setManage] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [amount, setAmount] = useState(1);
  const [time, setTime] = useState(() => nowHhMm());
  const [logging, setLogging] = useState(false);
  const [logError, setLogError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Supplement | "new" | null>(null);

  function load() {
    setLoadError(null);
    listSupplements(true)
      .then(setSupps)
      .catch((err) => setLoadError(errMsg(err)));
  }

  useEffect(load, []);

  const active = (supps ?? []).filter((s) => !s.archived);
  const query = search.trim().toLowerCase();
  const visible = query
    ? active.filter((s) => s.name.toLowerCase().includes(query))
    : active;

  function toggleSelect(s: Supplement) {
    if (selectedId === s.id) {
      setSelectedId(null);
    } else {
      setSelectedId(s.id);
      setAmount(1);
      setTime(nowHhMm());
      setLogError(null);
    }
  }

  async function log(s: Supplement) {
    setLogging(true);
    setLogError(null);
    try {
      await addSupplementLog(s.id, amount, dayTimeToIso(day, time));
      onLogged();
    } catch (err) {
      setLogError(errMsg(err));
      setLogging(false);
    }
  }

  function doseSub(s: Supplement): string {
    return s.dose_amount != null
      ? `${numToInput(s.dose_amount)}${s.dose_unit ? ` ${s.dose_unit}` : ""} per dose`
      : "Dose size not set";
  }

  const loading = supps === null && loadError === null;

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 14,
          }}
        >
          <h2 className="sheet-title" style={{ margin: 0 }}>
            {manage ? "Manage supplements" : "Log supplement"}
          </h2>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => {
              setManage((v) => !v);
              setSelectedId(null);
            }}
          >
            {manage ? "Done" : "Manage"}
          </button>
        </div>

        {loadError && (
          <div className="error-text" style={{ marginBottom: 10 }}>
            {loadError}
          </div>
        )}
        {loading && (
          <div style={{ display: "flex", justifyContent: "center", padding: 24 }}>
            <span className="spinner" />
          </div>
        )}

        {supps && !manage && (
          <>
            {active.length > 6 && (
              <div className="field">
                <input
                  className="input"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search supplements…"
                />
              </div>
            )}
            {active.length === 0 ? (
              <div className="empty">
                <div className="empty-icon">💊</div>
                No supplements yet — create one below.
              </div>
            ) : visible.length === 0 ? (
              <div className="empty">No supplements match “{search.trim()}”.</div>
            ) : (
              <div className="list">
                {visible.map((s) => (
                  <div key={s.id}>
                    <div
                      className="list-row"
                      role="button"
                      tabIndex={0}
                      style={{ cursor: "pointer" }}
                      onClick={() => toggleSelect(s)}
                      onKeyDown={(ev) => {
                        if (ev.key === "Enter") toggleSelect(s);
                      }}
                    >
                      <GlyphThumb glyph="💊" />
                      <div className="row-main">
                        <div className="row-title">{s.name}</div>
                        <div className="row-sub">{doseSub(s)}</div>
                      </div>
                      <div className="row-end">{selectedId === s.id ? "▾" : "›"}</div>
                    </div>
                    {selectedId === s.id && (
                      <div className="card" style={{ marginTop: 6, marginBottom: 0 }}>
                        <AmountStepper
                          value={amount}
                          onChange={setAmount}
                          doseAmount={s.dose_amount}
                          doseUnit={s.dose_unit}
                        />
                        <div className="field" style={{ margin: "10px 0 12px" }}>
                          <label className="label">Taken at</label>
                          <input
                            className="input"
                            type="time"
                            value={time}
                            onChange={(e) => setTime(e.target.value)}
                          />
                        </div>
                        {logError && (
                          <div className="error-text" style={{ marginBottom: 8 }}>
                            {logError}
                          </div>
                        )}
                        <button
                          className="btn btn-primary btn-block"
                          onClick={() => log(s)}
                          disabled={logging}
                        >
                          {logging ? (
                            <>
                              <span className="spinner" /> Logging…
                            </>
                          ) : (
                            "Log"
                          )}
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {supps && manage && (
          <>
            {supps.length === 0 ? (
              <div className="empty">
                <div className="empty-icon">💊</div>
                No supplements yet — create one below.
              </div>
            ) : (
              <div className="list">
                {supps.map((s) => (
                  <div
                    key={s.id}
                    className="list-row"
                    role="button"
                    tabIndex={0}
                    style={{ cursor: "pointer" }}
                    onClick={() => setEditing(s)}
                    onKeyDown={(ev) => {
                      if (ev.key === "Enter") setEditing(s);
                    }}
                  >
                    <GlyphThumb glyph="💊" />
                    <div className="row-main">
                      <div className="row-title">
                        {s.name}
                        {s.archived ? (
                          <span className="chip" style={{ marginLeft: 8 }}>
                            archived
                          </span>
                        ) : null}
                      </div>
                      <div className="row-sub">{doseSub(s)}</div>
                    </div>
                    <div className="row-end">Edit ›</div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {supps && (
          <button
            className="btn btn-ghost btn-block"
            style={{ marginTop: 12 }}
            onClick={() => setEditing("new")}
          >
            + New supplement
          </button>
        )}

        {editing && (
          <SupplementEditorSheet
            initial={editing === "new" ? null : editing}
            onClose={() => setEditing(null)}
            onSaved={() => {
              setEditing(null);
              setSupps(null);
              setSelectedId(null);
              load();
              onMutated();
            }}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add chooser sheet
// ---------------------------------------------------------------------------

type AddKind = "meal" | "workout" | "supp";

function AddChooserSheet({
  onClose,
  onPick,
}: {
  onClose: () => void;
  onPick: (kind: AddKind) => void;
}) {
  const options: { kind: AddKind; glyph: string; title: string; sub: string }[] = [
    { kind: "meal", glyph: "🍽", title: "Meal", sub: "Photo + AI nutrition" },
    {
      kind: "workout",
      glyph: "🏃",
      title: "Workout",
      sub: "Screenshot + AI import — burns calories",
    },
    { kind: "supp", glyph: "💊", title: "Supplement", sub: "Log a dose" },
  ];
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        <h2 className="sheet-title">Add to diary</h2>
        <div className="list">
          {options.map((o) => (
            <div
              key={o.kind}
              className="list-row"
              role="button"
              tabIndex={0}
              style={{ cursor: "pointer", padding: "16px 14px" }}
              onClick={() => onPick(o.kind)}
              onKeyDown={(ev) => {
                if (ev.key === "Enter") onPick(o.kind);
              }}
            >
              <GlyphThumb glyph={o.glyph} />
              <div className="row-main">
                <div className="row-title">{o.title}</div>
                <div className="row-sub">{o.sub}</div>
              </div>
              <div className="row-end">›</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Diary page
// ---------------------------------------------------------------------------

type TimelineItem =
  | { kind: "meal"; ts: string; entry: FoodEntry }
  | { kind: "workout"; ts: string; workout: Workout }
  | { kind: "supp"; ts: string; log: SupplementLogWithSupplement };

type SheetKind = "chooser" | AddKind;

export default function DiaryPage() {
  const [day, setDay] = useState(() => todayStr());
  const [entries, setEntries] = useState<FoodEntry[] | null>(null);
  const [workouts, setWorkouts] = useState<Workout[] | null>(null);
  const [suppLogs, setSuppLogs] = useState<SupplementLogWithSupplement[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showTotals, setShowTotals] = useState(false);
  const [detail, setDetail] = useState<TimelineItem | null>(null);
  const [sheet, setSheet] = useState<SheetKind | null>(null);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let alive = true;
    setEntries(null);
    setWorkouts(null);
    setSuppLogs(null);
    setLoadError(null);
    Promise.all([
      listFoodEntriesForDay(day),
      listWorkoutsForDay(day),
      listSupplementLogsForDay(day),
    ])
      .then(([e, w, s]) => {
        if (!alive) return;
        setEntries(e);
        setWorkouts(w);
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

  const eaten = useMemo(
    () => (entries ?? []).reduce((acc, e) => acc + (e.nutrients.calories ?? 0), 0),
    [entries],
  );
  const burned = useMemo(
    () => (workouts ?? []).reduce((acc, w) => acc + w.calories_burned, 0),
    [workouts],
  );

  const timeline = useMemo<TimelineItem[]>(() => {
    const items: TimelineItem[] = [
      ...(entries ?? []).map((e) => ({ kind: "meal" as const, ts: e.eaten_at, entry: e })),
      ...(workouts ?? []).map((w) => ({
        kind: "workout" as const,
        ts: w.performed_at,
        workout: w,
      })),
      ...(suppLogs ?? []).map((l) => ({
        kind: "supp" as const,
        ts: l.taken_at,
        log: l,
      })),
    ];
    items.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
    return items;
  }, [entries, workouts, suppLogs]);

  const isToday = day === todayStr();
  const loaded = entries !== null && workouts !== null && suppLogs !== null;
  const loading = !loaded && loadError === null;
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

      <button className="btn btn-primary btn-block" onClick={() => setSheet("chooser")}>
        + Add
      </button>

      {loadError && (
        <div className="error-text" style={{ margin: "14px 2px" }}>
          {loadError}
        </div>
      )}

      {loading && (
        <div style={{ display: "flex", justifyContent: "center", padding: 32 }}>
          <span className="spinner" />
        </div>
      )}

      {loaded && !loadError && (
        <>
          <div className="section-title">Daily totals</div>
          <div className="stat-grid">
            <div className="stat">
              <div className="stat-value">{Math.round(eaten)}</div>
              <div className="stat-label">Eaten</div>
            </div>
            <div className="stat">
              <div className="stat-value">{Math.round(burned)}</div>
              <div className="stat-label">Burned</div>
            </div>
            <div className="stat">
              <div className="stat-value">{fmtSignedInt(eaten - burned)}</div>
              <div className="stat-label">Net</div>
            </div>
            <div className="stat">
              <div className="stat-value">{Math.round(totals.protein_g ?? 0)}g</div>
              <div className="stat-label">Protein</div>
            </div>
          </div>
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

          <div className="section-title">Timeline</div>
          {timeline.length === 0 ? (
            <div className="empty">
              <div className="empty-icon">🌿</div>
              Nothing logged {isToday ? "yet today" : "this day"}.
            </div>
          ) : (
            <div className="list">
              {timeline.map((item) => {
                if (item.kind === "meal") {
                  const e = item.entry;
                  return (
                    <div
                      key={`meal-${e.id}`}
                      className="list-row"
                      role="button"
                      tabIndex={0}
                      style={{ cursor: "pointer" }}
                      onClick={() => setDetail(item)}
                      onKeyDown={(ev) => {
                        if (ev.key === "Enter") setDetail(item);
                      }}
                    >
                      {e.photo_path ? (
                        <PhotoImg
                          filename={e.photo_path}
                          className="photo-thumb"
                          alt={e.title}
                        />
                      ) : (
                        <GlyphThumb glyph="🍽" />
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
                  );
                }
                if (item.kind === "workout") {
                  const w = item.workout;
                  return (
                    <div
                      key={`workout-${w.id}`}
                      className="list-row"
                      role="button"
                      tabIndex={0}
                      style={{ cursor: "pointer" }}
                      onClick={() => setDetail(item)}
                      onKeyDown={(ev) => {
                        if (ev.key === "Enter") setDetail(item);
                      }}
                    >
                      <GlyphThumb glyph="🏃" />
                      <div className="row-main">
                        <div className="row-title">{w.title}</div>
                        <div className="row-sub">
                          {timeOf(w.performed_at)}
                          {w.model_id ? " · AI import" : " · manual"}
                        </div>
                        <div className="chips" style={{ marginTop: 6 }}>
                          <span className="chip chip-accent">
                            −{Math.round(w.calories_burned)} kcal
                          </span>
                          {w.duration_min != null && (
                            <span className="chip">{w.duration_min} min</span>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                }
                const l = item.log;
                return (
                  <div
                    key={`supp-${l.id}`}
                    className="list-row"
                    role="button"
                    tabIndex={0}
                    style={{ cursor: "pointer" }}
                    onClick={() => setDetail(item)}
                    onKeyDown={(ev) => {
                      if (ev.key === "Enter") setDetail(item);
                    }}
                  >
                    <GlyphThumb glyph="💊" />
                    <div className="row-main">
                      <div className="row-title">{l.name}</div>
                      <div className="row-sub">
                        {timeOf(l.taken_at)} · {numToInput(l.amount)}
                        {l.dose_amount != null
                          ? ` × ${numToInput(l.dose_amount)}${l.dose_unit ? ` ${l.dose_unit}` : ""}`
                          : l.amount === 1
                            ? " dose"
                            : " doses"}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {detail?.kind === "meal" && (
        <MealDetailSheet
          entry={detail.entry}
          onClose={() => setDetail(null)}
          onChanged={bump}
        />
      )}
      {detail?.kind === "workout" && (
        <WorkoutDetailSheet
          workout={detail.workout}
          onClose={() => setDetail(null)}
          onChanged={bump}
        />
      )}
      {detail?.kind === "supp" && (
        <SuppLogDetailSheet
          log={detail.log}
          onClose={() => setDetail(null)}
          onChanged={bump}
        />
      )}

      {sheet === "chooser" && (
        <AddChooserSheet onClose={() => setSheet(null)} onPick={(k) => setSheet(k)} />
      )}
      {sheet === "meal" && (
        <AddMealSheet
          day={day}
          onClose={() => setSheet(null)}
          onSaved={() => {
            setSheet(null);
            bump();
          }}
        />
      )}
      {sheet === "workout" && (
        <AddWorkoutSheet
          day={day}
          onClose={() => setSheet(null)}
          onSaved={() => {
            setSheet(null);
            bump();
          }}
        />
      )}
      {sheet === "supp" && (
        <SupplementSheet
          day={day}
          onClose={() => setSheet(null)}
          onLogged={() => {
            setSheet(null);
            bump();
          }}
          onMutated={bump}
        />
      )}
    </div>
  );
}
