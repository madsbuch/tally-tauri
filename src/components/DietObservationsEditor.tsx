import { useState } from "react";
import { EMPTY_DIET } from "../lib/diet";
import { updateFoodEntry } from "../lib/db";
import type { FoodEntry } from "../lib/types";

const FIELDS = [
  ["main_meal", "Main meal (breakfast, lunch or dinner)"],
  ["vegetable_forward", "Vegetables are the main part"],
  ["refined_carbs", "Contains refined carbs"],
  ["candy", "Candy or chocolate"],
  ["alcohol", "Alcoholic drink"],
] as const;

export default function DietObservationsEditor({ meal, onSaved }: { meal: FoodEntry; onSaved: () => void }) {
  const [draft, setDraft] = useState(meal.diet ?? { ...EMPTY_DIET });
  const [drinks, setDrinks] = useState(meal.diet?.drinks?.toString() ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const count = drinks.trim() ? Number(drinks) : null;
      if (count != null && (!Number.isFinite(count) || count < 0)) throw new Error("Enter a drink count of zero or more, or leave it blank.");
      await updateFoodEntry({ ...meal, diet: { ...draft, drinks: draft.alcohol === false ? null : count, occasion: draft.occasion?.trim() || null } });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save observations.");
    } finally { setBusy(false); }
  }
  return <details className="diet-card diet-editor">
    <summary>Diet observations · review or correct</summary>
    <p className="muted small">These describe the food. Unknown is fine. You can also ask the entry chat to classify or correct it.</p>
    <fieldset disabled={busy}>
      {FIELDS.map(([key, label]) => <label className="diet-field" key={key}>
        <span>{label}</span>
        <select className="input" value={draft[key] == null ? "unknown" : draft[key] ? "yes" : "no"} onChange={(e) => setDraft({ ...draft, [key]: e.target.value === "unknown" ? null : e.target.value === "yes" })}>
          <option value="unknown">Unknown</option><option value="yes">Yes</option><option value="no">No</option>
        </select>
      </label>)}
      <label className="diet-field"><span>Number of alcoholic drinks</span><input className="input" type="number" min="0" step="any" placeholder="Unknown" value={drinks} disabled={draft.alcohol === false} onChange={(e) => setDrinks(e.target.value)} /></label>
      <label className="label">Occasion label (optional)
        <input className="input" maxLength={100} value={draft.occasion ?? ""} placeholder="e.g. Friday dinner, Oct 30" onChange={(e) => setDraft({ ...draft, occasion: e.target.value || null })} />
      </label>
      <p className="muted small">Leave blank for automatic grouping. Give all entries from one occasion the same unique label, or different labels to separate them.</p>
      {error && <p className="error-text" role="alert">{error}</p>}
      <button className="btn btn-primary btn-block" onClick={() => void save()}>{busy ? "Saving…" : "Save observations"}</button>
    </fieldset>
  </details>;
}
