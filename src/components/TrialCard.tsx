/**
 * One trial of an experiment: which option it got, and how it went.
 *
 * Every tap saves — a rating is something you give in passing, an hour after
 * a meal, and a Save button would be one more thing between you and putting
 * the phone down. The same card sits on the experiment's page and, for the
 * refeed just after a fast, on the Diary's fasting card.
 */
import { useState } from "react";
import type { Experiment, ExperimentTrial } from "../lib/types";
import type { TrialMetrics } from "../lib/experiments";
import {
  AUTO_METRIC_INFO,
  armName,
  armOf,
  autoMetricsOf,
  ratingMeasures,
  removeTrial,
  saveTrial,
} from "../lib/experiments";

function whenLabel(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatMetric(key: keyof typeof AUTO_METRIC_INFO, v: number): string {
  const info = AUTO_METRIC_INFO[key];
  const sign = key === "weight_change_kg" && v > 0 ? "+" : "";
  return `${sign}${v.toFixed(info.dp)} ${info.unit}`;
}

export default function TrialCard({
  experiment: e,
  trial: t,
  metrics,
  compact = false,
}: {
  experiment: Experiment;
  trial: ExperimentTrial;
  /** The diary numbers, when the page has read them. */
  metrics?: TrialMetrics | undefined;
  /** Just the ratings and the option — for the fasting card. */
  compact?: boolean;
}) {
  const [note, setNote] = useState(t.note ?? "");
  const [busy, setBusy] = useState(false);
  const ratings = ratingMeasures(e);
  const autos = autoMetricsOf(e);

  async function patch(p: Parameters<typeof saveTrial>[1]) {
    setBusy(true);
    try {
      await saveTrial(t.id, p);
    } finally {
      setBusy(false);
    }
  }

  async function rate(key: string, v: number) {
    const next = { ...(t.ratings ?? {}) };
    if (next[key] === v) delete next[key];
    else next[key] = v;
    await patch({ ratings: Object.keys(next).length ? next : null });
  }

  async function remove() {
    if (!window.confirm("Delete this trial?")) return;
    await removeTrial(t.id);
  }

  const arm = armOf(e, t.arm);

  return (
    // On the fasting card it sits inside that card's own, so no second frame.
    <div
      className={compact ? undefined : "card"}
      style={{ marginBottom: compact ? 0 : 10, opacity: t.excluded ? 0.6 : 1 }}
    >
      {!compact && (
        <div className="exp-trial-head">
          <div className="row-title">{whenLabel(t.started_at)}</div>
          {t.excluded && <span className="chip chip-warn">Not counted</span>}
        </div>
      )}

      <div className="label" style={{ marginTop: compact ? 0 : 8 }}>Option</div>
      <div className="seg exp-arm-seg">
        {e.arms.map((a) => (
          <button
            key={a.key}
            className={`seg-item${t.arm === a.key ? " seg-item-active" : ""}`}
            disabled={busy}
            aria-label={`${a.key}: ${a.label}`}
            onClick={() => void patch({ arm: a.key })}
          >
            {a.key}
          </button>
        ))}
      </div>
      {arm ? (
        <div style={{ marginTop: 6 }}>
          <div className="small" style={{ fontWeight: 650 }}>{arm.label}</div>
          {arm.detail && <div className="muted small">{arm.detail}</div>}
        </div>
      ) : (
        <div className="error-text small">Option {armName(undefined, t.arm)} no longer exists.</div>
      )}

      {ratings.map((m) => (
        <div key={m.key} style={{ marginTop: 10 }}>
          <div className="label">{m.label}</div>
          <div className="exp-rating">
            {[1, 2, 3, 4, 5].map((v) => (
              <button
                key={v}
                className={t.ratings?.[m.key] === v ? "on" : ""}
                disabled={busy}
                onClick={() => void rate(m.key, v)}
              >
                {v}
              </button>
            ))}
          </div>
          <div className="exp-rating-ends">
            <span>{m.better === "higher" ? "worse" : "better"}</span>
            <span>{m.better === "higher" ? "better" : "worse"}</span>
          </div>
        </div>
      ))}

      {!compact && metrics && autos.length > 0 && (
        <div className="chips" style={{ marginTop: 10 }}>
          {autos.map((k) => {
            const v = metrics[k];
            return (
              <span key={k} className="chip">
                {AUTO_METRIC_INFO[k].label}: {v == null ? "—" : formatMetric(k, v)}
              </span>
            );
          })}
        </div>
      )}

      {!compact && (
        <>
          <div className="field" style={{ marginTop: 10, marginBottom: 6 }}>
            <input
              className="input"
              placeholder="Note (anything that bears on it)"
              value={note}
              onChange={(ev) => setNote(ev.target.value)}
              onBlur={() => {
                const next = note.trim() || null;
                if (next !== t.note) void patch({ note: next });
              }}
            />
          </div>
          <div className="input-row">
            <button
              className="btn btn-sm"
              disabled={busy}
              onClick={() => void patch({ excluded: !t.excluded })}
            >
              {t.excluded ? "Count it" : "Don't count"}
            </button>
            <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => void remove()}>
              Delete
            </button>
          </div>
        </>
      )}
    </div>
  );
}
