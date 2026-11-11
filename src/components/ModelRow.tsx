import { promptPricePerMillion } from "../lib/openrouter";
import type { ORModel } from "../lib/types";

function priceLabel(m: ORModel): string | null {
  const p = promptPricePerMillion(m);
  if (p == null) return null;
  if (p === 0) return "free";
  return `$${p < 0.01 ? p.toFixed(3) : p.toFixed(2)}/M tokens`;
}

export function modelSub(m: ORModel): string {
  const parts: string[] = [m.id];
  const price = priceLabel(m);
  if (price) parts.push(price);
  if (m.context_length) parts.push(`${Math.round(m.context_length / 1000)}k context`);
  return parts.join(" · ");
}

/** A tappable model row with a checkmark when selected. */
export default function ModelRow({
  model,
  selected,
  onSelect,
}: {
  model: ORModel;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      className="list-row"
      onClick={() => onSelect(model.id)}
      style={{
        font: "inherit",
        color: "inherit",
        textAlign: "left",
        width: "100%",
        cursor: "pointer",
        ...(selected ? { borderColor: "var(--accent)" } : {}),
      }}
    >
      <div className="row-main">
        <div className="row-title">{model.name}</div>
        <div className="row-sub">{modelSub(model)}</div>
      </div>
      {selected && (
        <div className="row-end" style={{ color: "var(--accent)", fontWeight: 700 }}>
          ✓
        </div>
      )}
    </button>
  );
}
