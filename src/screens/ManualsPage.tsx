/**
 * The manuals: one page per recurring situation, written by the coach.
 *
 * There's no "new" button on purpose — a manual is what the coach works out
 * from your diary and your conversations, so the way to start one is to ask.
 * Each can still be edited by hand once it exists.
 */
import { useEffect, useState } from "react";
import { listManuals } from "../lib/db";
import type { Manual } from "../lib/types";
import {
  MANUAL_GLYPH,
  TRIGGER_LABELS,
  manualPath,
  onManualsChanged,
  updatedLabel,
} from "../lib/manuals";
import InfoButton from "../components/InfoButton";
import { useGo, useUp } from "../lib/navigation";

export default function ManualsPage() {
  const [manuals, setManuals] = useState<Manual[] | null>(null);
  const [refresh, setRefresh] = useState(0);
  const up = useUp();
  const go = useGo();

  useEffect(() => {
    let alive = true;
    listManuals()
      .then((m) => {
        if (alive) setManuals(m);
      })
      .catch(() => {
        if (alive) setManuals([]);
      });
    return () => {
      alive = false;
    };
  }, [refresh]);

  // The coach can write one mid-conversation while this is open.
  useEffect(() => onManualsChanged(() => setRefresh((n) => n + 1)), []);

  return (
    <div className="page">
      <header className="page-header">
        <h1 className="page-title" style={{ display: "flex", alignItems: "center", gap: 2 }}>
          Manuals
          <InfoButton title="Manuals">
            <p>
              What works for you in situations that come back: fasting,
              travelling, a race week. The coach writes them from what it
              sees in your diary and what you tell it, and keeps them up to
              date.
            </p>
            <p>
              The coach reads a manual when its situation comes up. The
              fasting one is in front of it whenever a fast is running. You
              can edit any of them, and earlier versions are kept.
            </p>
          </InfoButton>
        </h1>
        <button className="btn btn-ghost btn-sm" onClick={up}>
          ‹ Coach
        </button>
      </header>

      {manuals === null && (
        <div style={{ display: "flex", justifyContent: "center", padding: 32 }}>
          <span className="spinner" />
        </div>
      )}

      {manuals !== null && manuals.length === 0 && (
        <div className="empty">
          <div className="empty-icon">{MANUAL_GLYPH}</div>
          No manuals yet.
          <div className="faint small" style={{ marginTop: 4 }}>
            Ask the coach, e.g. &ldquo;Start a manual for how I fast&rdquo;.
          </div>
        </div>
      )}

      {manuals !== null && manuals.length > 0 && (
        <div className="list">
          {manuals.map((m) => (
            <button
              key={m.id}
              className="list-row chat-suggestion"
              style={{ width: "100%", textAlign: "left" }}
              onClick={() => go(manualPath(m.id))}
            >
              <div className="row-main">
                <div className="row-title">{m.title}</div>
                <div className="row-sub" style={{ whiteSpace: "normal" }}>
                  {m.situation}
                </div>
                <div className="chips" style={{ marginTop: 6 }}>
                  {m.applies_when && (
                    <span className="chip chip-accent">{TRIGGER_LABELS[m.applies_when]}</span>
                  )}
                  <span className="chip">{updatedLabel(m)}</span>
                </div>
              </div>
              <div className="row-end">›</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
