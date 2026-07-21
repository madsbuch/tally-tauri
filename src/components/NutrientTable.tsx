import { NUTRIENT_DEFS, formatAmount } from "../lib/nutrients";
import type { Nutrients } from "../lib/types";

/**
 * Two-column table of all present nutrients, grouped into macros, micros and
 * other compounds. Missing keys are skipped.
 */
export default function NutrientTable({ nutrients }: { nutrients: Nutrients }) {
  const sections = (
    [
      { group: "macro", title: "Macros" },
      { group: "micro", title: "Micros" },
      { group: "other", title: "Other" },
    ] as const
  )
    .map((s) => ({
      ...s,
      defs: NUTRIENT_DEFS.filter((d) => d.group === s.group && nutrients[d.key] != null),
    }))
    .filter((s) => s.defs.length > 0);

  if (sections.length === 0) {
    return <div className="muted small">No nutrient data.</div>;
  }

  return (
    <div>
      {sections.map((s, i) => (
        <div key={s.group}>
          <div className="section-title" style={i === 0 ? { marginTop: 6 } : undefined}>
            {s.title}
          </div>
          <div className="nutrient-grid">
            {s.defs.map((d) => (
              <div key={d.key} className="nutrient-row">
                <span className="n-label">{d.label}</span>
                <span className="n-value">{formatAmount(d.key, nutrients[d.key]!)}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
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
