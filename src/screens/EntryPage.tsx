/**
 * One diary entry, as a page.
 *
 * It used to be a modal with every field in a form at once, which was fine
 * when an entry was a title and four numbers. It isn't any more: a meal
 * carries a dozen nutrients, a photo, an icon, a time in the zone it was
 * eaten in, and now a way to argue with the estimate. So the entry gets a
 * page that reads as a record — what this was, when, what's in it — and each
 * line opens a sheet for that one thing when you tap it. Nothing is a form
 * until you ask it to be.
 */
import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  deleteFoodEntry,
  deletePhotoIfUnused,
  deleteSupplementLog,
  deleteWorkout,
  getFoodEntry,
  getSupplementLog,
  getWorkout,
  todayStr,
  updateFoodEntry,
  updateSupplementLog,
  updateWorkout,
} from "../lib/db";
import { notifyDiaryChanged } from "../lib/agent";
import { NUTRIENT_DEFS } from "../lib/nutrients";
import type { NutrientKey } from "../lib/types";
import type {
  FoodEntry,
  Nutrients,
  SupplementLogWithSupplement,
  Workout,
} from "../lib/types";
import {
  dayOf,
  formatTimeHere,
  isElsewhere,
  isoFromLocal,
  offsetLabel,
  timeOf,
} from "../lib/daystamp";
import {
  IconPicker,
  PhotoImg,
  errMsg,
  numToInput,
  workoutGlyph,
} from "../components/EntryBits";
import { entryGlyph } from "../lib/icons";
import { useSheetHistory } from "../lib/sheetHistory";
import EntryReviseBox from "../components/EntryReviseBox";

type Kind = "meal" | "workout" | "supplement";

/** Nutrients shown without asking; the rest hide behind "all nutrients". */
const BASE_KEYS: NutrientKey[] = ["calories", "protein_g", "carbs_g", "fat_g"];

function isKind(v: string | undefined): v is Kind {
  return v === "meal" || v === "workout" || v === "supplement";
}

function longDate(day: string): string {
  const [y = 0, m = 1, d = 1] = day.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const today = todayStr();
  if (day === today) return "Today";
  return date.toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function InfoRow({
  label,
  value,
  onClick,
}: {
  label: string;
  value: React.ReactNode;
  onClick?: (() => void) | undefined;
}) {
  if (!onClick) {
    return (
      <div className="info-row info-row-static">
        <span className="info-label">{label}</span>
        <span className="info-value">{value}</span>
      </div>
    );
  }
  return (
    <button className="info-row" onClick={onClick}>
      <span className="info-label">{label}</span>
      <span className="info-value">{value}</span>
      <span className="info-chev">›</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// The one-field editor
// ---------------------------------------------------------------------------

/**
 * A sheet holding exactly one thing. Everything editable on this page goes
 * through it, so a correction is always: tap the line, change the one value,
 * save.
 */
function EditSheet({
  title,
  onClose,
  onSave,
  children,
}: {
  title: string;
  onClose: () => void;
  onSave: () => Promise<void>;
  children: React.ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useSheetHistory(true, onClose);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await onSave();
      onClose();
    } catch (e) {
      setError(errMsg(e));
      setBusy(false);
    }
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        <h2 className="sheet-title">{title}</h2>
        {children}
        {error && (
          <div className="error-text" style={{ marginTop: 10 }}>
            {error}
          </div>
        )}
        <div className="btn-row" style={{ marginTop: 16 }}>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={() => void save()} disabled={busy}>
            {busy ? <span className="spinner" /> : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Which field is being edited: the page keeps one of these at a time. */
type Editing =
  | { field: "title" }
  | { field: "description" }
  | { field: "when" }
  | { field: "icon" }
  | { field: "nutrient"; key: NutrientKey }
  | { field: "calories_burned" }
  | { field: "duration" }
  | { field: "amount" };

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

export default function EntryPage() {
  const params = useParams();
  const navigate = useNavigate();
  const kind = isKind(params["kind"]) ? params["kind"] : null;
  const id = Number(params["id"]);

  const [meal, setMeal] = useState<FoodEntry | null>(null);
  const [workout, setWorkout] = useState<Workout | null>(null);
  const [dose, setDose] = useState<SupplementLogWithSupplement | null>(null);
  const [loading, setLoading] = useState(true);
  const [gone, setGone] = useState(false);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!kind || !Number.isInteger(id)) {
      setGone(true);
      setLoading(false);
      return;
    }
    try {
      if (kind === "meal") {
        const e = await getFoodEntry(id);
        setMeal(e);
        setGone(e === null);
      } else if (kind === "workout") {
        const w = await getWorkout(id);
        setWorkout(w);
        setGone(w === null);
      } else {
        const l = await getSupplementLog(id);
        setDose(l);
        setGone(l === null);
      }
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, [kind, id]);

  useEffect(() => {
    void load();
  }, [load]);

  const back = () => navigate(-1);

  async function afterChange() {
    notifyDiaryChanged();
    await load();
  }

  async function remove() {
    const what = meal?.title ?? workout?.title ?? dose?.name ?? "this entry";
    if (!window.confirm(`Delete "${what}"? This cannot be undone.`)) return;
    try {
      if (meal) {
        await deleteFoodEntry(meal.id);
        await deletePhotoIfUnused(meal.photo_path);
      } else if (workout) {
        await deleteWorkout(workout.id);
        await deletePhotoIfUnused(workout.photo_path);
      } else if (dose) {
        await deleteSupplementLog(dose.id);
      }
      notifyDiaryChanged();
      back();
    } catch (e) {
      setError(errMsg(e));
    }
  }

  if (loading) {
    return (
      <div className="page">
        <div style={{ display: "flex", justifyContent: "center", padding: 40 }}>
          <span className="spinner" />
        </div>
      </div>
    );
  }

  if (gone || (!meal && !workout && !dose)) {
    return (
      <div className="page">
        <header className="page-header">
          <button className="btn btn-ghost btn-sm" onClick={back}>
            ‹ Back
          </button>
        </header>
        {error ? (
          <div className="error-text">{error}</div>
        ) : (
          <div className="empty">
            <div className="empty-icon">🗑</div>
            This entry is no longer there.
          </div>
        )}
      </div>
    );
  }

  // -- the three shapes, reduced to what the page draws --------------------
  const photo = meal?.photo_path ?? workout?.photo_path ?? null;
  const when = meal?.eaten_at ?? workout?.performed_at ?? dose?.taken_at ?? "";
  const offset =
    meal?.tz_offset_min ?? workout?.tz_offset_min ?? dose?.tz_offset_min ?? null;
  const day = meal?.day ?? workout?.day ?? dose?.day ?? dayOf(when, offset);
  const title = meal?.title ?? workout?.title ?? dose?.name ?? "";
  const glyph = meal
    ? entryGlyph(meal.icon, meal.title, "meal")
    : workout
      ? workoutGlyph(workout)
      : "💊";

  return (
    <div className="page entry-page">
      <header className="page-header">
        <button className="btn btn-ghost btn-sm" onClick={back}>
          ‹ Diary
        </button>
      </header>

      {photo ? (
        <PhotoImg filename={photo} className="entry-photo" alt={title} />
      ) : (
        <div className="entry-glyph">{glyph}</div>
      )}

      {meal || workout ? (
        <button className="entry-title" onClick={() => setEditing({ field: "title" })}>
          {title}
          <span className="entry-title-edit">✎</span>
        </button>
      ) : (
        // A dose is named by its supplement, which is edited in the catalog.
        <div className="entry-title">{title}</div>
      )}

      <div className="list" style={{ marginTop: 12 }}>
        <InfoRow
          label="When"
          value={`${longDate(day)} · ${formatTimeHere(when, offset)}`}
          onClick={() => setEditing({ field: "when" })}
        />
        {!photo && (meal || workout) && (
          <InfoRow
            label="Icon"
            value={glyph}
            onClick={() => setEditing({ field: "icon" })}
          />
        )}
        {dose && (
          <>
            <InfoRow
              label="Doses"
              value={numToInput(dose.amount)}
              onClick={() => setEditing({ field: "amount" })}
            />
            <InfoRow
              label="One dose"
              value={
                dose.dose_amount != null
                  ? `${numToInput(dose.dose_amount)}${dose.dose_unit ? ` ${dose.dose_unit}` : ""}`
                  : "not set"
              }
            />
          </>
        )}
        {workout && (
          <>
            <InfoRow
              label="Burned"
              value={`${Math.round(workout.calories_burned)} kcal`}
              onClick={() => setEditing({ field: "calories_burned" })}
            />
            <InfoRow
              label="Duration"
              value={
                workout.duration_min != null ? `${Math.round(workout.duration_min)} min` : "—"
              }
              onClick={() => setEditing({ field: "duration" })}
            />
          </>
        )}
      </div>

      {meal && (
        <>
          <div className="section-title">Nutrition</div>
          <div className="list">
            {NUTRIENT_DEFS.filter(
              (d) =>
                showAll || BASE_KEYS.includes(d.key) || meal.nutrients[d.key] != null,
            ).map((d) => (
              <InfoRow
                key={d.key}
                label={d.label}
                value={
                  meal.nutrients[d.key] != null
                    ? `${numToInput(meal.nutrients[d.key] as number)} ${d.unit}`
                    : "—"
                }
                onClick={() => setEditing({ field: "nutrient", key: d.key })}
              />
            ))}
          </div>
          <button
            className="btn btn-ghost btn-sm btn-block"
            style={{ marginTop: 8 }}
            onClick={() => setShowAll((v) => !v)}
          >
            {showAll ? "Fewer nutrients" : "All nutrients"}
          </button>
        </>
      )}

      {(meal || workout) && (
        <EntryReviseBox
          kind={meal ? "meal" : "workout"}
          meal={meal}
          workout={workout}
          onApplied={() => void afterChange()}
        />
      )}

      {(meal || workout) && (
        <>
          <div className="section-title">Notes</div>
          <div className="list">
            <InfoRow
              label="Description"
              value={meal?.description ?? workout?.description ?? "—"}
              onClick={() => setEditing({ field: "description" })}
            />
          </div>
        </>
      )}

      <p className="faint small" style={{ margin: "18px 2px 0" }}>
        {(meal?.model_id ?? workout?.model_id)
          ? `Estimated by ${meal?.model_id ?? workout?.model_id}`
          : workout?.source
            ? `Synced from ${workout.source}`
            : "Entered by hand"}
        {offset != null && isElsewhere(offset)
          ? ` · logged in ${offsetLabel(offset)}`
          : ""}
      </p>

      {error && (
        <div className="error-text" style={{ marginTop: 12 }}>
          {error}
        </div>
      )}

      <div className="btn-row" style={{ marginTop: 18 }}>
        <button className="btn btn-danger btn-block" onClick={() => void remove()}>
          Delete entry
        </button>
      </div>

      {editing && (
        <FieldEditor
          editing={editing}
          meal={meal}
          workout={workout}
          dose={dose}
          onClose={() => setEditing(null)}
          onSaved={() => void afterChange()}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The editors, one field each
// ---------------------------------------------------------------------------

function FieldEditor({
  editing,
  meal,
  workout,
  dose,
  onClose,
  onSaved,
}: {
  editing: Editing;
  meal: FoodEntry | null;
  workout: Workout | null;
  dose: SupplementLogWithSupplement | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const when = meal?.eaten_at ?? workout?.performed_at ?? dose?.taken_at ?? "";
  const offset =
    meal?.tz_offset_min ?? workout?.tz_offset_min ?? dose?.tz_offset_min ?? null;

  const [text, setText] = useState(
    () =>
      (editing.field === "title"
        ? (meal?.title ?? workout?.title ?? "")
        : editing.field === "description"
          ? (meal?.description ?? workout?.description ?? "")
          : "") as string,
  );
  const [date, setDate] = useState(
    () => meal?.day ?? workout?.day ?? dose?.day ?? dayOf(when, offset),
  );
  const [time, setTime] = useState(() => timeOf(when, offset));
  const [icon, setIcon] = useState<string | null>(meal?.icon ?? workout?.icon ?? null);
  const [num, setNum] = useState(() => {
    if (editing.field === "nutrient") {
      const v = meal?.nutrients[editing.key];
      return v != null ? numToInput(v) : "";
    }
    if (editing.field === "calories_burned") {
      return workout ? numToInput(workout.calories_burned) : "";
    }
    if (editing.field === "duration") {
      return workout?.duration_min != null ? numToInput(workout.duration_min) : "";
    }
    if (editing.field === "amount") return dose ? numToInput(dose.amount) : "";
    return "";
  });

  /** A number field, empty meaning "not recorded". */
  function parseNum(required: boolean): number | null {
    const raw = num.trim();
    if (!raw) {
      if (required) throw new Error("Give it a number.");
      return null;
    }
    const n = parseFloat(raw);
    if (!isFinite(n) || n < 0) throw new Error("It has to be a number, and not negative.");
    return n;
  }

  async function save() {
    const at =
      editing.field === "when"
        ? (() => {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Pick a valid date.");
            return isoFromLocal(date, time, offset);
          })()
        : when;

    if (meal) {
      const patch: FoodEntry = { ...meal };
      if (editing.field === "title") {
        const t = text.trim();
        if (!t) throw new Error("A title is required.");
        patch.title = t;
      } else if (editing.field === "description") {
        patch.description = text.trim() || null;
      } else if (editing.field === "when") {
        patch.eaten_at = at;
      } else if (editing.field === "icon") {
        patch.icon = icon;
      } else if (editing.field === "nutrient") {
        const nutrients: Nutrients = { ...meal.nutrients };
        const v = parseNum(false);
        if (v == null) delete nutrients[editing.key];
        else nutrients[editing.key] = v;
        patch.nutrients = nutrients;
      }
      await updateFoodEntry(patch);
    } else if (workout) {
      const patch: Workout = { ...workout };
      if (editing.field === "title") {
        const t = text.trim();
        if (!t) throw new Error("A title is required.");
        patch.title = t;
      } else if (editing.field === "description") {
        patch.description = text.trim() || null;
      } else if (editing.field === "when") {
        patch.performed_at = at;
      } else if (editing.field === "icon") {
        patch.icon = icon;
      } else if (editing.field === "calories_burned") {
        patch.calories_burned = Math.round(parseNum(true) ?? 0);
      } else if (editing.field === "duration") {
        const v = parseNum(false);
        patch.duration_min = v != null && v > 0 ? Math.round(v) : null;
      }
      await updateWorkout(patch);
    } else if (dose) {
      const amount =
        editing.field === "amount" ? Math.max(0.5, parseNum(true) ?? 1) : dose.amount;
      await updateSupplementLog(dose.id, amount, at, dose.tz_offset_min);
    }
    onSaved();
  }

  const heading =
    editing.field === "nutrient"
      ? (NUTRIENT_DEFS.find((d) => d.key === editing.key)?.label ?? "Nutrient")
      : editing.field === "when"
        ? "When"
        : editing.field === "calories_burned"
          ? "Calories burned"
          : editing.field === "duration"
            ? "Duration"
            : editing.field === "amount"
              ? "Doses"
              : editing.field === "title"
                ? "Title"
                : editing.field === "icon"
                  ? "Icon"
                  : "Description";

  const unit =
    editing.field === "nutrient"
      ? NUTRIENT_DEFS.find((d) => d.key === editing.key)?.unit
      : editing.field === "calories_burned"
        ? "kcal"
        : editing.field === "duration"
          ? "min"
          : undefined;
  const sheetTitle = unit ? `${heading} (${unit})` : heading;

  return (
    <EditSheet title={sheetTitle} onClose={onClose} onSave={save}>
      {editing.field === "title" && (
        <input
          className="input"
          value={text}
          autoFocus
          onChange={(e) => setText(e.target.value)}
        />
      )}
      {editing.field === "description" && (
        <textarea
          className="input"
          rows={3}
          value={text}
          placeholder="What it is, portion size…"
          onChange={(e) => setText(e.target.value)}
        />
      )}
      {editing.field === "when" && (
        <div className="input-row">
          <div>
            <label className="label">Date</label>
            <input
              className="input"
              type="date"
              max={todayStr()}
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div>
            <label className="label">Time</label>
            <input
              className="input"
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
            />
          </div>
        </div>
      )}
      {editing.field === "icon" && (
        <IconPicker
          kind={workout ? "workout" : "meal"}
          title={meal?.title ?? workout?.title ?? ""}
          value={icon}
          onChange={setIcon}
        />
      )}
      {(editing.field === "nutrient" ||
        editing.field === "calories_burned" ||
        editing.field === "duration" ||
        editing.field === "amount") && (
        <div className="field">
          <input
            className="input"
            type="number"
            min={0}
            step="any"
            inputMode="decimal"
            autoFocus
            placeholder="—"
            value={num}
            onChange={(e) => setNum(e.target.value)}
          />
          {editing.field === "nutrient" && (
            <p className="faint small" style={{ margin: "6px 2px 0" }}>
              Leave it empty to record nothing for this one.
            </p>
          )}
        </div>
      )}
    </EditSheet>
  );
}
