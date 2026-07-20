import { NUTRIENT_DEFS, formatAmount } from "../lib/nutrients";
import type { Nutrients } from "../lib/types";

/**
 * Two-column table of all present nutrients, grouped into macros and micros.
 * Missing keys are skipped.
 */
export default function NutrientTable({ nutrients }: { nutrients: Nutrients }) {
  const macros = NUTRIENT_DEFS.filter(
    (d) => d.group === "macro" && nutrients[d.key] != null,
  );
  const micros = NUTRIENT_DEFS.filter(
    (d) => d.group === "micro" && nutrients[d.key] != null,
  );

  if (macros.length === 0 && micros.length === 0) {
    return <div className="muted small">No nutrient data.</div>;
  }

  return (
    <div>
      {macros.length > 0 && (
        <>
          <div className="section-title" style={{ marginTop: 6 }}>
            Macros
          </div>
          <div className="nutrient-grid">
            {macros.map((d) => (
              <div key={d.key} className="nutrient-row">
                <span className="n-label">{d.label}</span>
                <span className="n-value">{formatAmount(d.key, nutrients[d.key]!)}</span>
              </div>
            ))}
          </div>
        </>
      )}
      {micros.length > 0 && (
        <>
          <div className="section-title">Micros</div>
          <div className="nutrient-grid">
            {micros.map((d) => (
              <div key={d.key} className="nutrient-row">
                <span className="n-label">{d.label}</span>
                <span className="n-value">{formatAmount(d.key, nutrients[d.key]!)}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** Compact macro summary chips: kcal, protein, carbs, fat. */
export function MacroChips({ nutrients }: { nutrients: Nutrients }) {
  const items: { label: string; value: string }[] = [];
  if (nutrients.calories != null) items.push({ label: "", value: `${Math.round(nutrients.calories)} kcal` });
  if (nutrients.protein_g != null) items.push({ label: "P", value: `${Math.round(nutrients.protein_g)}g` });
  if (nutrients.carbs_g != null) items.push({ label: "C", value: `${Math.round(nutrients.carbs_g)}g` });
  if (nutrients.fat_g != null) items.push({ label: "F", value: `${Math.round(nutrients.fat_g)}g` });
  if (items.length === 0) return null;
  return (
    <div className="chips">
      {items.map((it, i) => (
        <span key={i} className="chip">
          {it.label && <span className="faint">{it.label}</span>}
          {it.value}
        </span>
      ))}
    </div>
  );
}
