/**
 * "Tell it what was wrong."
 *
 * The one place in the app where you correct an estimate by arguing with it
 * rather than by typing numbers. What comes back is applied straight away —
 * the entry is the record, and a preview step between you and your own diary
 * is friction — but what changed is spelled out, and undo puts it back.
 */
import { useState } from "react";
import { reviseMeal, reviseWorkout, undoRevision } from "../lib/entryRevision";
import type { Revision } from "../lib/entryRevision";
import { errMsg } from "./EntryBits";
import type { FoodEntry, Workout } from "../lib/types";

const PLACEHOLDER = "e.g. the cheese block was 7 g, not 3 g";

export default function EntryReviseBox({
  kind,
  meal,
  workout,
  onApplied,
}: {
  kind: "meal" | "workout";
  meal: FoodEntry | null;
  workout: Workout | null;
  onApplied: () => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Revision<FoodEntry | Workout> | null>(null);

  async function ask() {
    const instruction = text.trim();
    if (!instruction || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r =
        kind === "meal" && meal
          ? ((await reviseMeal(meal, instruction)) as Revision<FoodEntry | Workout>)
          : workout
            ? ((await reviseWorkout(workout, instruction)) as Revision<FoodEntry | Workout>)
            : null;
      if (!r) return;
      setResult(r);
      setText("");
      onApplied();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  async function undo() {
    if (!result) return;
    setBusy(true);
    try {
      await undoRevision(result.before);
      setResult(null);
      onApplied();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="revise-box">
      <div className="label">Correct it</div>
      <textarea
        className="input revise-input"
        rows={2}
        placeholder={PLACEHOLDER}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // Enter is a line break on a phone; send is the button.
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void ask();
          }
        }}
        disabled={busy}
      />
      <div className="btn-row" style={{ marginTop: 8 }}>
        <button
          className="btn btn-primary btn-block"
          onClick={() => void ask()}
          disabled={busy || !text.trim()}
        >
          {busy ? <span className="spinner" /> : "Re-estimate"}
        </button>
      </div>

      {error && (
        <div className="error-text" style={{ marginTop: 10 }}>
          {error}
        </div>
      )}

      {result && (
        <div className="revise-result">
          {result.note && <p className="revise-note">{result.note}</p>}
          {result.changes.length > 0 ? (
            <ul className="revise-changes">
              {result.changes.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          ) : (
            <p className="muted small" style={{ margin: 0 }}>
              Nothing changed.
            </p>
          )}
          <button
            className="btn btn-sm"
            style={{ marginTop: 10 }}
            onClick={() => void undo()}
            disabled={busy}
          >
            Undo
          </button>
        </div>
      )}
    </div>
  );
}
