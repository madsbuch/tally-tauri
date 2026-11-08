import { useEffect, useState } from "react";
import { clearFastOk, getFastOkNote, setFoodEntryFastOk } from "../lib/db";
import type { FoodEntry } from "../lib/types";
import { FAST_BREAK_KCAL } from "../lib/types";

/**
 * Whether this food breaks a fast — the user's call, with their reason.
 * Applies to the food by title (see setFoodEntryFastOk), so the line reads
 * the same on every entry of it.
 */
export default function MealFastOk({ meal, onSaved }: {
  meal: FoodEntry;
  onSaved: () => Promise<void>;
}) {
  const [note, setNote] = useState<string | null>(meal.fast_ok_note);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getFastOkNote(meal.title)
      .then((n) => {
        if (!cancelled) setNote(n);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [meal.title, meal.fast_ok_note]);

  const kcal = meal.nutrients.calories;
  // Under the threshold it never breaks a fast anyway — nothing to decide.
  if (note == null && kcal != null && kcal < FAST_BREAK_KCAL) return null;

  async function run(action: () => Promise<void>) {
    setSaving(true);
    setError(null);
    try {
      await action();
      setEditing(false);
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <form
        className="info-row info-row-static"
        style={{ display: "block" }}
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => setFoodEntryFastOk(meal.id, draft.trim() || "Doesn't break a fast"));
        }}
      >
        <span className="info-label">Why doesn't it break a fast?</span>
        <input
          className="input"
          style={{ marginTop: 6 }}
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="e.g. supplement, negligible calories"
          maxLength={200}
        />
        <div className="btn-row" style={{ marginTop: 6 }}>
          <button type="button" className="btn btn-ghost btn-sm" disabled={saving} onClick={() => setEditing(false)}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary btn-sm" disabled={saving}>
            {saving ? <span className="spinner" /> : "Save"}
          </button>
        </div>
        {error && <p className="error-text small" role="alert">{error}</p>}
      </form>
    );
  }

  return (
    <div>
      <button
        className="info-row"
        disabled={saving}
        onClick={() => {
          if (note == null) {
            setDraft("");
            setEditing(true);
          } else if (
            window.confirm(`Count "${meal.title}" as breaking a fast again? This applies to every entry of it.`)
          ) {
            void run(() => clearFastOk(meal.title));
          }
        }}
      >
        <span className="info-label">Fasting</span>
        <span className="info-value">
          {note == null ? "Breaks a fast" : `Doesn't break a fast · ${note}`}
        </span>
        <span className="info-chev">›</span>
      </button>
      {error && <p className="error-text small" role="alert">{error}</p>}
    </div>
  );
}
