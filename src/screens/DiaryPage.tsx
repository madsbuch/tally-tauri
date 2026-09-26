import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type {
  Capture,
  FoodEntry,
  NutrientKey,
  Nutrients,
  SleepSession,
  Supplement,
  SupplementLogWithSupplement,
  Workout,
} from "../lib/types";
import { DEFAULT_VISION_MODEL, SETTING_KEYS } from "../lib/types";
import { NUTRIENT_DEFS, NUTRIENT_KEYS } from "../lib/nutrients";
import {
  dayOf,
  formatRangeHere,
  formatTimeHere,
  isoFromLocal,
  timeOf as localHhMm,
} from "../lib/daystamp";
import {
  GlyphThumb,
  IconPicker,
  PhotoImg,
  errMsg,
  fmtDuration,
  numToInput,
  workoutGlyph,
} from "../components/EntryBits";
import { useSheetHistory } from "../lib/sheetHistory";
import {
  addFoodEntry,
  addSupplement,
  addSupplementLog,
  addWorkout,
  deletePhotoIfUnused,
  deleteSupplement,
  getSetting,
  listCapturesForDay,
  listFoodEntriesForDay,
  listFoodEntriesForRange,
  listHealthMetricsForRange,
  listSleepForRange,
  listSupplementLogsForDay,
  listSupplementLogsForRange,
  listSupplements,
  listWorkoutsForDay,
  listWorkoutsForRange,
  setDayGoalAdjustment,
  todayStr,
  updateSupplement,
} from "../lib/db";
import {
  discardCapture,
  enqueueCapture,
  onDiaryChanged,
  retryCapture,
} from "../lib/agent";
import { analyzeSupplement } from "../lib/openrouter";
import { compressImage, savePhoto } from "../lib/photos";
import { MacroChips } from "../components/NutrientTable";
import AchievementsSheet from "../components/AchievementsSheet";
import { ACHIEVEMENTS_BY_KEY, onAchievementsUnlocked } from "../lib/achievements";
import { getStreakInfo } from "../lib/streak";
import type { StreakInfo } from "../lib/streak";
import { entryGlyph } from "../lib/icons";
import {
  MAX_MANUAL_ADJUSTMENT,
  getDayGoal,
  getPeriodGoal,
  loadGoalSettings,
} from "../lib/goals";
import type { DayGoal, PeriodGoal } from "../lib/goals";

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

/** Shift a "YYYY-MM-DD" local day string by whole days. */
function shiftDay(day: string, delta: number): string {
  const [y = 0, m = 1, d = 1] = day.split("-").map(Number);
  return todayStr(new Date(y, m - 1, d + delta));
}

function dayTitle(day: string): string {
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

/** "Jul 14", with the year appended only when it isn't the current year. */
function shortDate(day: string): string {
  const [y = 0, m = 1, d = 1] = day.split("-").map(Number);
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  if (y !== new Date().getFullYear()) opts.year = "numeric";
  return new Date(y, m - 1, d).toLocaleDateString(undefined, opts);
}

// ---------------------------------------------------------------------------
// Totals periods (day / week / month)
// ---------------------------------------------------------------------------

type TotalsPeriod = "day" | "week" | "month";

/** Monday-to-Sunday week containing `day`, both bounds inclusive. */
function weekRangeOf(day: string): { start: string; end: string } {
  const [y = 0, m = 1, d = 1] = day.split("-").map(Number);
  const monOffset = (new Date(y, m - 1, d).getDay() + 6) % 7; // Mon = 0
  const start = todayStr(new Date(y, m - 1, d - monOffset));
  return { start, end: shiftDay(start, 6) };
}

/** Calendar month containing `day`, both bounds inclusive. */
function monthRangeOf(day: string): { start: string; end: string } {
  const [y = 0, m = 1] = day.split("-").map(Number);
  return {
    start: todayStr(new Date(y, m - 1, 1)),
    end: todayStr(new Date(y, m, 0)),
  };
}

/** Whole days from `start` through `end`, both inclusive. */
function daysBetween(start: string, end: string): number {
  const toDate = (s: string) => {
    const [y = 0, m = 1, d = 1] = s.split("-").map(Number);
    return new Date(y, m - 1, d);
  };
  return Math.round((toDate(end).getTime() - toDate(start).getTime()) / 86_400_000) + 1;
}

function monthTitle(day: string): string {
  const [y = 0, m = 1] = day.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
}

/**
 * An entry's time as its own clock showed it — in the timezone it was logged
 * in, not the one the phone is in now (see lib/daystamp.ts).
 */
function timeOf(iso: string, offsetMin: number | null = null): string {
  return formatTimeHere(iso, offsetMin);
}

function hhmmOf(iso: string, offsetMin?: number | null): string {
  return localHhMm(iso, offsetMin);
}

function nowHhMm(): string {
  return hhmmOf(new Date().toISOString());
}

/**
 * Combine a local "YYYY-MM-DD" day and an "HH:MM" time into a UTC ISO string,
 * read in `offsetMin` — so retiming a meal eaten in Denmark from a US hotel
 * keeps it at the Danish hour rather than dragging it six hours.
 */
function dayTimeToIso(day: string, time: string, offsetMin?: number | null): string {
  const parsed = /^(\d{1,2}):(\d{2})/.exec(time);
  const hhmm = parsed ? `${parsed[1]}:${parsed[2]}` : nowHhMm();
  return isoFromLocal(day, hhmm, offsetMin);
}

/** Round-and-format, rendering negatives with a proper minus sign. */
function fmtSignedInt(n: number): string {
  const r = Math.round(n);
  return r < 0 ? `−${-r}` : String(r);
}

/** "+200" / "−200" — explicit sign, for corrections to a target. */
function fmtDelta(n: number): string {
  const r = Math.round(n);
  return r < 0 ? `−${-r}` : `+${r}`;
}

/** Accent fill on --bg-elev track; turns warn-colored when over budget. */
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

/** Nudges offered for a one-day target correction, in kcal. */
const QUICK_GOAL_DELTAS = [-500, -300, -200, -100, 100, 200, 300, 500];

/**
 * Manual correction to a single day's calorie target — "I overate yesterday,
 * take 200 off today". Writes straight through, so the card above updates as
 * soon as a button is tapped.
 */
function GoalAdjustPanel({
  goal,
  onChanged,
}: {
  goal: DayGoal;
  onChanged: () => void;
}) {
  const [draft, setDraft] = useState(() => (goal.manual === 0 ? "" : String(goal.manual)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Follow the stored value when it changes underneath (quick buttons, or
  // moving to another day while the panel stays open).
  useEffect(() => {
    setDraft(goal.manual === 0 ? "" : String(goal.manual));
  }, [goal.day, goal.manual]);

  async function commit(next: number) {
    const clamped = Math.max(
      -MAX_MANUAL_ADJUSTMENT,
      Math.min(MAX_MANUAL_ADJUSTMENT, Math.round(next)),
    );
    setBusy(true);
    setError(null);
    try {
      await setDayGoalAdjustment(goal.day, clamped);
      onChanged();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  function commitDraft() {
    const trimmed = draft.trim();
    const n = trimmed === "" ? 0 : parseFloat(trimmed);
    if (!isFinite(n)) {
      setDraft(goal.manual === 0 ? "" : String(goal.manual));
      return;
    }
    if (Math.round(n) === goal.manual) return;
    void commit(n);
  }

  return (
    <div className="goal-adjust">
      <div className="label" style={{ marginBottom: 6 }}>
        Correct this day&apos;s target
      </div>
      <div className="chips" style={{ marginBottom: 8 }}>
        {QUICK_GOAL_DELTAS.map((d) => (
          <button
            key={d}
            className="btn btn-sm"
            disabled={busy}
            onClick={() => void commit(goal.manual + d)}
          >
            {fmtDelta(d)}
          </button>
        ))}
      </div>
      <div className="input-row" style={{ alignItems: "center" }}>
        <input
          className="input"
          type="number"
          step={10}
          min={-MAX_MANUAL_ADJUSTMENT}
          max={MAX_MANUAL_ADJUSTMENT}
          inputMode="numeric"
          placeholder="0 kcal"
          value={draft}
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitDraft}
        />
        <button
          className="btn btn-sm"
          style={{ flex: "0 0 auto" }}
          disabled={busy || goal.manual === 0}
          onClick={() => void commit(0)}
        >
          Clear
        </button>
      </div>
      {error && (
        <div className="error-text" style={{ marginTop: 8 }}>
          {error}
        </div>
      )}
      <p className="faint small" style={{ margin: "8px 0 0" }}>
        Applies to this day only. Your week and month budgets don&apos;t change —
        the room comes off this day and stays on the others, so paying back an
        overshoot leaves the period level. The Settings target stays as it is.
      </p>
    </div>
  );
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
// Unified add sheet — photo-first; the model decides meal vs. workout
// ---------------------------------------------------------------------------

type EntryKind = "meal" | "workout";

function AddSheet({
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
  const [queuing, setQueuing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Shared edit-step state (carried over when the kind is switched).
  const [kind, setKind] = useState<EntryKind>("meal");
  const [title, setTitle] = useState("");
  const [time, setTime] = useState(() => nowHhMm());
  const [icon, setIcon] = useState<string | null>(null);

  // Meal-specific state.
  const [nutrVals, setNutrVals] = useState<Partial<Record<NutrientKey, string>>>({});
  const [showAllN, setShowAllN] = useState(false);

  // Workout-specific state.
  const [calStr, setCalStr] = useState("");
  const [durStr, setDurStr] = useState("");

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

  /**
   * Fire-and-forget: store the capture instantly and close the sheet. The
   * agent analyzes in the background; the timeline shows it working.
   */
  async function addToDiary() {
    setError(null);
    if (!photo && !note.trim()) {
      setError("Add a photo or a note first.");
      return;
    }
    setQueuing(true);
    try {
      await enqueueCapture({ photoBase64: photo?.base64, note, day });
      onSaved();
    } catch (err) {
      setError(errMsg(err));
      setQueuing(false);
    }
  }

  function enterManually() {
    setError(null);
    setStep("edit");
  }

  function switchKind(k: EntryKind) {
    if (k === kind) return;
    setKind(k);
    setIcon(null); // meal and workout icons come from different sets
    setError(null);
  }

  async function save() {
    const t = title.trim();
    if (!t) {
      setError(kind === "meal" ? "Give the meal a title." : "Give the workout a title.");
      return;
    }
    const nutrients: Nutrients = {};
    let cal = 0;
    let dur: number | null = null;
    if (kind === "meal") {
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
    } else {
      const calParsed = parseFloat(calStr);
      if (!isFinite(calParsed) || calParsed < 0) {
        setError("Calories burned must be a number ≥ 0.");
        return;
      }
      cal = Math.round(calParsed);
      const durParsed = parseFloat(durStr);
      dur =
        durStr.trim() && isFinite(durParsed) && durParsed > 0
          ? Math.round(durParsed)
          : null;
    }
    setSaving(true);
    setError(null);
    let photoPath: string | null = null;
    try {
      if (photo) photoPath = await savePhoto(photo.base64);

      if (kind === "meal") {
        await addFoodEntry({
          eaten_at: dayTimeToIso(day, time),
          title: t,
          description: note.trim() || null,
          photo_path: photoPath,
          nutrients,
          model_id: null,
          icon,
        });
      } else {
        await addWorkout({
          performed_at: dayTimeToIso(day, time),
          title: t,
          description: note.trim() || null,
          photo_path: photoPath,
          calories_burned: cal,
          duration_min: dur,
          model_id: null,
          icon,
        });
      }
      onSaved();
    } catch (err) {
      await deletePhotoIfUnused(photoPath);
      setError(errMsg(err));
      setSaving(false);
    }
  }

  const shownDefs = NUTRIENT_DEFS.filter((d) => showAllN || BASE_KEYS.includes(d.key));

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        <h2 className="sheet-title">{step === "capture" ? "Add to diary" : "Review"}</h2>

        {photo && (
          <div style={{ marginBottom: 12 }}>
            <img src={photo.dataUrl} className="photo-full" alt="Photo preview" />
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
                placeholder="e.g. large bowl, ~500 ml · 45 min easy run"
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
              onClick={addToDiary}
              disabled={queuing || (!photo && !note.trim())}
            >
              Add to diary
            </button>
            <div style={{ display: "flex", justifyContent: "center", marginTop: 8 }}>
              <button
                className="btn btn-ghost btn-sm"
                onClick={enterManually}
                disabled={queuing}
              >
                Enter manually
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="seg" style={{ marginBottom: 12 }}>
              <button
                className={kind === "meal" ? "seg-item seg-item-active" : "seg-item"}
                onClick={() => switchKind("meal")}
              >
                🍽 Meal
              </button>
              <button
                className={kind === "workout" ? "seg-item seg-item-active" : "seg-item"}
                onClick={() => switchKind("workout")}
              >
                🏃 Workout
              </button>
            </div>
            <div className="field">
              <label className="label">Title</label>
              <input
                className="input"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={kind === "meal" ? "e.g. Chicken salad" : "e.g. Morning run"}
                autoFocus
              />
            </div>
            {!photo && (
              <IconPicker kind={kind} title={title} value={icon} onChange={setIcon} />
            )}
            <div className="field">
              <label className="label">{kind === "meal" ? "Eaten at" : "Performed at"}</label>
              <input
                className="input"
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
              />
            </div>
            {kind === "meal" ? (
              <>
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
              </>
            ) : (
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
            )}
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

  useSheetHistory(editing !== null, () => setEditing(null));

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
// Failed-capture sheet (retry / discard)
// ---------------------------------------------------------------------------

function CaptureErrorSheet({
  capture,
  onClose,
}: {
  capture: Capture;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function retry() {
    setBusy(true);
    setError(null);
    try {
      await retryCapture(capture.id);
      onClose();
    } catch (err) {
      setError(errMsg(err));
      setBusy(false);
    }
  }

  async function discard() {
    if (!window.confirm("Discard this capture? Nothing will be logged.")) return;
    setBusy(true);
    setError(null);
    try {
      await discardCapture(capture);
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
        <h2 className="sheet-title">Analysis failed</h2>
        {capture.photo_path && (
          <div style={{ marginBottom: 12 }}>
            <PhotoImg filename={capture.photo_path} className="photo-full" alt="Capture" />
          </div>
        )}
        <div className="muted small" style={{ marginBottom: 8 }}>
          Captured {timeOf(capture.created_at)}
        </div>
        {capture.note && (
          <div className="muted small" style={{ marginBottom: 8 }}>
            {capture.note}
          </div>
        )}
        <div className="error-text">
          {capture.error || "The analysis failed for an unknown reason."}
        </div>
        {error && (
          <div className="error-text" style={{ marginTop: 10 }}>
            {error}
          </div>
        )}
        <div className="btn-row" style={{ marginTop: 16 }}>
          <button className="btn btn-danger" onClick={discard} disabled={busy}>
            Discard
          </button>
          <button className="btn btn-primary" onClick={retry} disabled={busy}>
            Retry
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Diary page
// ---------------------------------------------------------------------------

type TimelineItem =
  | { kind: "sleep"; ts: string; sleep: SleepSession }
  | { kind: "meal"; ts: string; entry: FoodEntry }
  | { kind: "workout"; ts: string; workout: Workout }
  | { kind: "supp"; ts: string; log: SupplementLogWithSupplement }
  | { kind: "capture"; ts: string; capture: Capture };

/** Where an entry's own page lives. */
function entryPath(item: TimelineItem): string {
  if (item.kind === "sleep") return `/entry/sleep/${item.sleep.id}`;
  if (item.kind === "meal") return `/entry/meal/${item.entry.id}`;
  if (item.kind === "workout") return `/entry/workout/${item.workout.id}`;
  if (item.kind === "supp") return `/entry/supplement/${item.log.id}`;
  return "/";
}

/** Short row title for a capture: its note, truncated, or "Photo". */
function captureTitle(c: Capture): string {
  const note = c.note?.trim();
  if (!note) return "Photo";
  return note.length > 48 ? `${note.slice(0, 48).trimEnd()}…` : note;
}

type SheetKind = "add" | "supp";

export default function DiaryPage() {
  const [day, setDay] = useState(() => todayStr());
  const [entries, setEntries] = useState<FoodEntry[] | null>(null);
  const [workouts, setWorkouts] = useState<Workout[] | null>(null);
  const [suppLogs, setSuppLogs] = useState<SupplementLogWithSupplement[] | null>(null);
  const [captures, setCaptures] = useState<Capture[] | null>(null);
  const [sleep, setSleep] = useState<SleepSession[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [period, setPeriod] = useState<TotalsPeriod>("day");
  const [rangeData, setRangeData] = useState<{
    key: string;
    entries: FoodEntry[];
    workouts: Workout[];
    suppLogs: SupplementLogWithSupplement[];
  } | null>(null);
  // Calorie goal for the shown scope: the day breakdown (base + corrections)
  // for the day view, a plain sum for week/month.
  const [dayGoal, setDayGoal] = useState<DayGoal | null>(null);
  const [periodGoal, setPeriodGoal] = useState<PeriodGoal | null>(null);
  const [hasTarget, setHasTarget] = useState<boolean | null>(null);
  const [showAdjust, setShowAdjust] = useState(false);
  const [detail, setDetail] = useState<TimelineItem | null>(null);
  const navigate = useNavigate();
  /** An entry has a page of its own now; only a failed capture opens a sheet. */
  const openItem = (item: TimelineItem) => {
    if (item.kind === "capture") setDetail(item);
    else navigate(entryPath(item));
  };
  const [sheet, setSheet] = useState<SheetKind | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [streak, setStreak] = useState<StreakInfo | null>(null);
  const [showAchievements, setShowAchievements] = useState(false);
  const [unlockToast, setUnlockToast] = useState<string | null>(null);

  // True when `day` was "today" at the time it was selected. Used to snap the
  // page forward after an overnight resume so new entries aren't stamped
  // ~24h in the past.
  const dayWasTodayRef = useRef(true);
  useEffect(() => {
    dayWasTodayRef.current = day === todayStr();
  }, [day]);

  useEffect(() => {
    function syncDay() {
      if (!dayWasTodayRef.current) return;
      const t = todayStr();
      setDay((d) => (d === t ? d : t));
    }
    window.addEventListener("focus", syncDay);
    document.addEventListener("visibilitychange", syncDay);
    return () => {
      window.removeEventListener("focus", syncDay);
      document.removeEventListener("visibilitychange", syncDay);
    };
  }, []);

  useSheetHistory(detail !== null, () => setDetail(null));
  useSheetHistory(sheet === "add", () => setSheet(null));
  useSheetHistory(sheet === "supp", () => setSheet(null));
  useSheetHistory(showAchievements, () => setShowAchievements(false));

  // Refresh whenever the background agent changes diary data — this is how a
  // pending capture row appears instantly and later turns into real entries.
  useEffect(() => onDiaryChanged(() => setRefresh((n) => n + 1)), []);

  // Streak follows every diary change (refresh bumps on those).
  useEffect(() => {
    let alive = true;
    getStreakInfo()
      .then((s) => {
        if (alive) setStreak(s);
      })
      .catch(() => {
        /* chip simply stays hidden */
      });
    return () => {
      alive = false;
    };
  }, [refresh]);

  // Toast newly unlocked achievements (from the background agent or scans).
  useEffect(
    () =>
      onAchievementsUnlocked((keys) => {
        const lastKey = keys[keys.length - 1];
        const def = lastKey ? ACHIEVEMENTS_BY_KEY.get(lastKey) : undefined;
        if (!def) return;
        const extra = keys.length > 1 ? ` (+${keys.length - 1} more)` : "";
        setUnlockToast(`${def.emoji} Achievement unlocked: ${def.title}${extra}`);
      }),
    [],
  );
  useEffect(() => {
    if (unlockToast === null) return;
    const id = window.setTimeout(() => setUnlockToast(null), 4500);
    return () => window.clearTimeout(id);
  }, [unlockToast]);

  // Day whose data is currently on screen. Background refreshes of the same
  // day keep stale rows visible (no full-page spinner) until fresh data lands.
  const shownDayRef = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    if (shownDayRef.current !== day) {
      setEntries(null);
      setWorkouts(null);
      setSuppLogs(null);
      setCaptures(null);
    }
    setLoadError(null);
    Promise.all([
      listFoodEntriesForDay(day),
      listWorkoutsForDay(day),
      listSupplementLogsForDay(day),
      listCapturesForDay(day),
      // A night is filed under the morning it ended on, so it belongs to this
      // day's timeline even though most of it happened yesterday.
      listSleepForRange(day, day).catch(() => [] as SleepSession[]),
    ])
      .then(([e, w, s, c, sl]) => {
        if (!alive) return;
        shownDayRef.current = day;
        setEntries(e);
        setWorkouts(w);
        setSuppLogs(s);
        setCaptures(c);
        setSleep(sl);
      })
      .catch((err) => {
        if (alive) setLoadError(errMsg(err));
      });
    return () => {
      alive = false;
    };
  }, [day, refresh]);

  // Week/month totals need entries beyond the shown day — fetch the range.
  const range =
    period === "week"
      ? weekRangeOf(day)
      : period === "month"
        ? monthRangeOf(day)
        : null;
  const rangeKey = range ? `${range.start}..${range.end}` : null;

  useEffect(() => {
    if (!rangeKey) {
      setRangeData(null);
      return;
    }
    const [start = "", end = ""] = rangeKey.split("..");
    let alive = true;
    Promise.all([
      listFoodEntriesForRange(start, end),
      listWorkoutsForRange(start, end),
      listSupplementLogsForRange(start, end),
    ])
      .then(([e, w, s]) => {
        if (alive) {
          setRangeData({ key: rangeKey, entries: e, workouts: w, suppLogs: s });
        }
      })
      .catch((err) => {
        if (alive) setLoadError(errMsg(err));
      });
    return () => {
      alive = false;
    };
  }, [rangeKey, refresh]);

  // Calorie goal for the shown scope: the Settings base target plus any
  // per-day corrections. Pages remount on tab switch, so a target edited in
  // Settings is picked up when coming back here.
  useEffect(() => {
    let alive = true;
    (async () => {
      const settings = await loadGoalSettings();
      if (!alive) return;
      setHasTarget(settings.base != null);
      if (rangeKey) {
        const [start = "", end = ""] = rangeKey.split("..");
        const g = await getPeriodGoal(start, end, settings);
        if (!alive) return;
        setPeriodGoal(g);
        setDayGoal(null);
      } else {
        const g = await getDayGoal(day, settings);
        if (!alive) return;
        setDayGoal(g);
        setPeriodGoal(null);
      }
    })().catch(() => {
      /* no target / unreadable settings — the card just stays hidden */
    });
    return () => {
      alive = false;
    };
  }, [day, rangeKey, refresh]);

  /**
   * Sleep for the shown day/period, synced from the watch: the night itself
   * for a day, the average night for a week or month. Null when nothing was
   * recorded, which hides the line rather than showing a zero.
   */
  const [sleepMin, setSleepMin] = useState<number | null>(null);
  useEffect(() => {
    const [start = day, end = day] = rangeKey ? rangeKey.split("..") : [day, day];
    let alive = true;
    listSleepForRange(start, end)
      .then((nights) => {
        if (!alive) return;
        const byDay = new Map<string, number>();
        for (const n of nights) {
          const d = n.day ?? dayOf(n.ended_at, n.tz_offset_min);
          byDay.set(d, (byDay.get(d) ?? 0) + n.duration_min);
        }
        const totals = [...byDay.values()];
        setSleepMin(
          totals.length === 0
            ? null
            : totals.reduce((a, b) => a + b, 0) / totals.length,
        );
      })
      .catch(() => {
        if (alive) setSleepMin(null);
      });
    return () => {
      alive = false;
    };
  }, [day, rangeKey, refresh]);

  // Steps for the shown day/period, synced from Health Connect. Null when no
  // day in the scope has step data (nothing synced) — the line is hidden then.
  const [steps, setSteps] = useState<number | null>(null);
  useEffect(() => {
    const [start = day, end = day] = rangeKey ? rangeKey.split("..") : [day, day];
    let alive = true;
    listHealthMetricsForRange(start, end)
      .then((ms) => {
        if (!alive) return;
        const vals = ms
          .map((m) => m.steps)
          .filter((s): s is number => s != null);
        setSteps(vals.length ? vals.reduce((a, b) => a + b, 0) : null);
      })
      .catch(() => {
        if (alive) setSteps(null);
      });
    return () => {
      alive = false;
    };
  }, [day, rangeKey, refresh]);

  // Lists the totals are computed over: the shown day, or the fetched range.
  const scopeEntries =
    period === "day" ? entries : rangeData?.key === rangeKey ? rangeData.entries : null;
  const scopeWorkouts =
    period === "day" ? workouts : rangeData?.key === rangeKey ? rangeData.workouts : null;
  const scopeSuppLogs =
    period === "day" ? suppLogs : rangeData?.key === rangeKey ? rangeData.suppLogs : null;

  const eaten = useMemo(
    () => (scopeEntries ?? []).reduce((acc, e) => acc + (e.nutrients.calories ?? 0), 0),
    [scopeEntries],
  );
  const burned = useMemo(
    () => (scopeWorkouts ?? []).reduce((acc, w) => acc + w.calories_burned, 0),
    [scopeWorkouts],
  );

  const timeline = useMemo<TimelineItem[]>(() => {
    const items: TimelineItem[] = [
      ...sleep.map((s) => ({ kind: "sleep" as const, ts: s.ended_at, sleep: s })),
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
      ...(captures ?? []).map((c) => ({
        kind: "capture" as const,
        ts: c.created_at,
        capture: c,
      })),
    ];
    items.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
    return items;
  }, [entries, workouts, suppLogs, captures, sleep]);

  const today = todayStr();
  const isToday = day === today;
  const loaded =
    entries !== null && workouts !== null && suppLogs !== null && captures !== null;
  const loading = !loaded && loadError === null;
  const bump = () => setRefresh((n) => n + 1);

  // Days in the shown week/month with no entries at all. Only elapsed days
  // count — today isn't "untracked" while it's still in progress. Watch-synced
  // workouts don't make a day tracked: nothing was logged here, so the day's
  // totals are still missing whatever was eaten.
  const untrackedDays = useMemo(() => {
    if (period === "day" || !range || scopeEntries === null) return 0;
    const tracked = new Set<string>();
    for (const e of scopeEntries ?? [])
      tracked.add(e.day ?? dayOf(e.eaten_at, e.tz_offset_min));
    for (const w of scopeWorkouts ?? []) {
      if (w.source == null)
        tracked.add(w.day ?? dayOf(w.performed_at, w.tz_offset_min));
    }
    for (const l of scopeSuppLogs ?? [])
      tracked.add(l.day ?? dayOf(l.taken_at, l.tz_offset_min));
    const today = todayStr();
    const last = range.end < today ? range.end : shiftDay(today, -1);
    let n = 0;
    for (let d = range.start; d <= last; d = shiftDay(d, 1)) {
      if (!tracked.has(d)) n++;
    }
    return n;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period, rangeKey, scopeEntries, scopeWorkouts, scopeSuppLogs]);

  // Totals-section derivations.
  const totalsReady = period === "day" ? loaded : scopeEntries !== null;
  const daysInPeriod = range ? daysBetween(range.start, range.end) : 1;
  const containsToday = range != null && range.start <= today && today <= range.end;
  const elapsedDays =
    range && containsToday ? daysBetween(range.start, today) : daysInPeriod;
  const net = eaten - burned;
  // Day view: base + this day's correction. Week/month: base × days plus the
  // corrections that fall inside the period.
  const goalBase = dayGoal?.base ?? periodGoal?.base ?? null;
  const periodTarget =
    period === "day" ? (dayGoal?.target ?? null) : (periodGoal?.target ?? null);
  const overTarget = periodTarget != null && net > periodTarget;
  const totalsTitle =
    period === "day"
      ? "Daily totals"
      : period === "week"
        ? containsToday
          ? "This week"
          : `Week of ${shortDate(range!.start)}`
        : containsToday
          ? "This month"
          : monthTitle(day);

  return (
    <div className="page page-with-fab">
      <header className="page-header">
        <h1 className="page-title">Diary</h1>
        {streak ? (
          <button
            className="streak-chip"
            onClick={() => setShowAchievements(true)}
            aria-label="Streak and achievements"
          >
            <span className={streak.current > 0 && streak.todayLogged ? "" : "streak-dim"}>
              🔥 {streak.current}
            </span>
            {streak.freezes > 0 && <span className="streak-freezes">❄️ {streak.freezes}</span>}
          </button>
        ) : (
          <span className="page-sub">{day}</span>
        )}
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
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              margin: "20px 2px 8px",
            }}
          >
            <div className="section-title" style={{ margin: 0 }}>
              {totalsTitle}
            </div>
            <div className="seg" style={{ padding: 2, gap: 2 }}>
              {(
                [
                  { value: "day", label: "Day" },
                  { value: "week", label: "Week" },
                  { value: "month", label: "Month" },
                ] as { value: TotalsPeriod; label: string }[]
              ).map((o) => (
                <button
                  key={o.value}
                  className={`seg-item${period === o.value ? " seg-item-active" : ""}`}
                  style={{ flex: "0 0 auto", padding: "4px 10px", fontSize: 12 }}
                  onClick={() => setPeriod(o.value)}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>
          {range && (
            <div className="faint small" style={{ margin: "-4px 2px 8px" }}>
              {shortDate(range.start)} – {shortDate(range.end)}
              {containsToday ? ` · day ${elapsedDays} of ${daysInPeriod}` : ""}
            </div>
          )}

          {!totalsReady ? (
            <div style={{ display: "flex", justifyContent: "center", padding: 20 }}>
              <span className="spinner" />
            </div>
          ) : (
            <>
              {untrackedDays > 0 && (
                <div
                  className="small"
                  style={{ margin: "0 2px 8px", color: "var(--warn)" }}
                >
                  ⚠ {untrackedDays} {untrackedDays === 1 ? "day" : "days"} in this
                  period {untrackedDays === 1 ? "has" : "have"} nothing logged —
                  totals{containsToday ? " and pace" : ""} are incomplete.
                </div>
              )}
              {goalBase != null && periodTarget != null && (
                <div className="card" style={{ marginTop: 0, marginBottom: 0 }}>
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
                      Calorie target
                    </div>
                    <span className={`chip ${overTarget ? "chip-warn" : "chip-accent"}`}>
                      {overTarget
                        ? `${Math.round(net - periodTarget)} kcal over`
                        : `${Math.round(periodTarget - net)} kcal left`}
                    </span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <MeterBar pct={(net / periodTarget) * 100} warn={overTarget} />
                    <span
                      style={{
                        flexShrink: 0,
                        fontSize: 12.5,
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      <span style={{ fontWeight: 650 }}>{fmtSignedInt(net)}</span>
                      <span className="faint"> / {Math.round(periodTarget)} kcal</span>
                    </span>
                  </div>
                  {dayGoal && dayGoal.manual !== 0 && (
                    <div className="faint small" style={{ marginTop: 8 }}>
                      {Math.round(dayGoal.base)} base · {fmtDelta(dayGoal.manual)}{" "}
                      corrected for this day
                    </div>
                  )}
                  {periodGoal && periodGoal.manual !== 0 && (
                    <div className="faint small" style={{ marginTop: 8 }}>
                      {fmtDelta(periodGoal.manual)} kcal corrected on single days
                      in this period — that shifts those days, not this budget.
                    </div>
                  )}
                  {period !== "day" && containsToday && (
                    <div className="faint small" style={{ marginTop: 8 }}>
                      Budget through today: {Math.round(goalBase * elapsedDays)} kcal
                      — you're {Math.abs(Math.round(goalBase * elapsedDays - net))}{" "}
                      kcal {goalBase * elapsedDays - net >= 0 ? "under" : "over"} pace.
                    </div>
                  )}
                  <div
                    className="faint small"
                    style={{ marginTop: period !== "day" && containsToday ? 4 : 8 }}
                  >
                    Net kcal (eaten − burned) vs {Math.round(goalBase)} kcal/day
                    {period !== "day" ? ` × ${daysInPeriod} days` : ""}.
                  </div>
                  {dayGoal && (
                    <>
                      <button
                        className="btn btn-sm"
                        style={{ marginTop: 10 }}
                        onClick={() => setShowAdjust((v) => !v)}
                        aria-expanded={showAdjust}
                      >
                        {showAdjust ? "Done" : "Adjust target"}
                      </button>
                      {showAdjust && (
                        <GoalAdjustPanel goal={dayGoal} onChanged={() => bump()} />
                      )}
                    </>
                  )}
                </div>
              )}
              {hasTarget === false && (
                <div className="faint small" style={{ margin: "8px 2px 0" }}>
                  Set a daily calorie target in Settings to track your budget here.
                </div>
              )}
              {(steps != null || sleepMin != null) && (
                <div className="day-stats muted small">
                  {steps != null && (
                    <span>
                      👟 {Math.round(steps).toLocaleString()} steps
                      {period !== "day" && elapsedDays > 0 && (
                        <span className="faint">
                          {" "}
                          ~{Math.round(steps / elapsedDays).toLocaleString()}/day
                        </span>
                      )}
                    </span>
                  )}
                  {sleepMin != null && (
                    <span>
                      😴 {fmtDuration(sleepMin) ?? "—"}
                      {period !== "day" && <span className="faint"> a night</span>}
                    </span>
                  )}
                </div>
              )}
            </>
          )}

          <div className="section-title">Timeline</div>
          {timeline.length === 0 ? (
            <div className="empty">
              <div className="empty-icon">🌿</div>
              Nothing logged {isToday ? "yet today" : "this day"}.
              <div className="faint small" style={{ marginTop: 4 }}>
                Snap a photo or jot a note with ＋ Add below.
              </div>
            </div>
          ) : (
            <div className="list">
              {timeline.map((item) => {
                if (item.kind === "sleep") {
                  const n = item.sleep;
                  return (
                    <div
                      key={`sleep-${n.id}`}
                      className="list-row"
                      role="button"
                      tabIndex={0}
                      style={{ cursor: "pointer" }}
                      onClick={() => openItem(item)}
                      onKeyDown={(ev) => {
                        if (ev.key === "Enter") openItem(item);
                      }}
                    >
                      <GlyphThumb glyph="😴" />
                      <div className="row-main">
                        <div className="row-title">
                          Slept {fmtDuration(n.duration_min) ?? "—"}
                        </div>
                        <div className="row-sub">
                          {formatRangeHere(n.started_at, n.ended_at, n.tz_offset_min)}
                          {n.source ? ` · ${n.source}` : ""}
                        </div>
                        {n.deep_min != null && (
                          <div className="chips" style={{ marginTop: 6 }}>
                            <span className="chip">
                              {Math.round(n.deep_min)} min deep
                            </span>
                            {n.rem_min != null && (
                              <span className="chip">{Math.round(n.rem_min)} min REM</span>
                            )}
                          </div>
                        )}
                      </div>
                      <div className="row-end">›</div>
                    </div>
                  );
                }
                if (item.kind === "meal") {
                  const e = item.entry;
                  return (
                    <div
                      key={`meal-${e.id}`}
                      className="list-row"
                      role="button"
                      tabIndex={0}
                      style={{ cursor: "pointer" }}
                      onClick={() => openItem(item)}
                      onKeyDown={(ev) => {
                        if (ev.key === "Enter") openItem(item);
                      }}
                    >
                      {e.photo_path ? (
                        <PhotoImg
                          filename={e.photo_path}
                          className="photo-thumb"
                          alt={e.title}
                        />
                      ) : (
                        <GlyphThumb glyph={entryGlyph(e.icon, e.title, "meal")} />
                      )}
                      <div className="row-main">
                        <div className="row-title">{e.title}</div>
                        <div className="row-sub">
                          {timeOf(e.eaten_at, e.tz_offset_min)}
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
                      onClick={() => openItem(item)}
                      onKeyDown={(ev) => {
                        if (ev.key === "Enter") openItem(item);
                      }}
                    >
                      <GlyphThumb glyph={workoutGlyph(w)} />
                      <div className="row-main">
                        <div className="row-title">{w.title}</div>
                        <div className="row-sub">
                          {timeOf(w.performed_at, w.tz_offset_min)}
                          {w.source
                            ? ` · ${w.source}`
                            : w.model_id
                              ? " · AI import"
                              : " · manual"}
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
                if (item.kind === "capture") {
                  const c = item.capture;
                  const failed = c.status === "error";
                  const thumb = c.photo_path ? (
                    <PhotoImg
                      filename={c.photo_path}
                      className="photo-thumb"
                      alt={captureTitle(c)}
                    />
                  ) : (
                    <GlyphThumb glyph="📸" />
                  );
                  if (!failed) {
                    // Pending: the agent is working — not tappable.
                    return (
                      <div key={`capture-${c.id}`} className="list-row">
                        {thumb}
                        <div className="row-main">
                          <div className="row-title">{captureTitle(c)}</div>
                          <div
                            className="row-sub"
                            style={{ display: "flex", alignItems: "center", gap: 6 }}
                          >
                            {timeOf(c.created_at)} ·{" "}
                            <span
                              className="spinner"
                              style={{ width: 12, height: 12, flex: "0 0 auto" }}
                            />
                            <span className="muted">Analyzing…</span>
                          </div>
                        </div>
                      </div>
                    );
                  }
                  return (
                    <div
                      key={`capture-${c.id}`}
                      className="list-row"
                      role="button"
                      tabIndex={0}
                      style={{ cursor: "pointer" }}
                      onClick={() => openItem(item)}
                      onKeyDown={(ev) => {
                        if (ev.key === "Enter") openItem(item);
                      }}
                    >
                      {thumb}
                      <div className="row-main">
                        <div className="row-title">{captureTitle(c)}</div>
                        <div className="row-sub">{timeOf(c.created_at)}</div>
                        <div className="chips" style={{ marginTop: 6 }}>
                          <span className="chip chip-warn">Analysis failed</span>
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
                    onClick={() => openItem(item)}
                    onKeyDown={(ev) => {
                      if (ev.key === "Enter") openItem(item);
                    }}
                  >
                    <GlyphThumb glyph="💊" />
                    <div className="row-main">
                      <div className="row-title">{l.name}</div>
                      <div className="row-sub">
                        {timeOf(l.taken_at, l.tz_offset_min)} · {numToInput(l.amount)}
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

      {/* One-hand actions: fixed in the thumb zone above the tabbar. Open
          sheets cover them with their z-100 backdrop, so no hiding logic. */}
      <div className="fab-stack">
        <button
          className="fab fab-secondary"
          onClick={() => setSheet("supp")}
          aria-label="Log supplement"
          title="Log supplement"
        >
          💊
        </button>
        <button className="fab" onClick={() => setSheet("add")}>
          ＋ Add
        </button>
      </div>

      {detail?.kind === "capture" && (
        <CaptureErrorSheet capture={detail.capture} onClose={() => setDetail(null)} />
      )}

      {sheet === "add" && (
        <AddSheet
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
      {showAchievements && (
        <AchievementsSheet streak={streak} onClose={() => setShowAchievements(false)} />
      )}
      {unlockToast && (
        <div className="toast" role="status">
          {unlockToast}
        </div>
      )}
    </div>
  );
}
