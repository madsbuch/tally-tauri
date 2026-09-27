/**
 * Logging how you feel.
 *
 * The thing this has to get right is the moment it's used in. Nobody opens
 * their phone to describe being bloated, or to write a paragraph about a
 * depressive afternoon — so the whole sheet is one tap deep: the states you
 * log most often are already chips, tapping one selects it, and Log saves.
 * The note and the time are there when the moment deserves them and skipped
 * when it doesn't.
 *
 * Several states at once is the normal case rather than a special one — tired
 * AND bloated AND irritable is one moment, not three trips through a form —
 * and each becomes its own row, so "bloated" can be counted across weeks
 * without unpicking a sentence.
 */
import { useEffect, useState } from "react";
import { addStateLog, listRecentStateLabels } from "../lib/db";
import { isoFromLocal, timeOf } from "../lib/daystamp";
import { STATE_PRESETS, presetForLabel, stateGlyph } from "../lib/states";
import { errMsg } from "./EntryBits";

interface Choice {
  label: string;
  /** Preset key, or null for something they typed themselves. */
  icon: string | null;
}

const keyOf = (label: string): string => label.trim().toLowerCase();

export default function StateSheet({
  day,
  onClose,
  onLogged,
}: {
  /** The diary day being added to — today, or one being looked back at. */
  day: string;
  onClose: () => void;
  onLogged: () => void;
}) {
  const [recent, setRecent] = useState<Choice[]>([]);
  const [picked, setPicked] = useState<Map<string, Choice>>(new Map());
  const [custom, setCustom] = useState("");
  const [note, setNote] = useState("");
  const [time, setTime] = useState(() => timeOf(new Date().toISOString()));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listRecentStateLabels()
      .then(setRecent)
      // Their own history is a nicety; the presets below still work without it.
      .catch(() => setRecent([]));
  }, []);

  // Theirs first, then the built-ins they haven't already used.
  const seen = new Set(recent.map((r) => keyOf(r.label)));
  const choices: Choice[] = [
    ...recent,
    ...STATE_PRESETS.filter((p) => !seen.has(keyOf(p.label))).map((p) => ({
      label: p.label,
      icon: p.key,
    })),
  ];

  function toggle(c: Choice) {
    setPicked((prev) => {
      const next = new Map(prev);
      const k = keyOf(c.label);
      if (next.has(k)) next.delete(k);
      else next.set(k, c);
      return next;
    });
    setError(null);
  }

  /** Everything that would be written: the chips, plus anything typed. */
  function chosen(): Choice[] {
    const out = [...picked.values()];
    const typed = custom.trim();
    if (typed && !picked.has(keyOf(typed))) {
      // Typing a preset's name by hand should still get its glyph.
      out.push({ label: typed, icon: presetForLabel(typed)?.key ?? null });
    }
    return out;
  }

  const count = chosen().length;

  async function save() {
    const states = chosen();
    if (states.length === 0 || saving) return;
    setSaving(true);
    setError(null);
    try {
      const loggedAt = isoFromLocal(day, time);
      // One row each, sharing the moment and the note that came with it.
      for (const s of states) {
        await addStateLog({ label: s.label, icon: s.icon, note, loggedAt });
      }
      onLogged();
    } catch (e) {
      setError(errMsg(e));
      setSaving(false);
    }
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        <h2 className="sheet-title">How do you feel?</h2>

        <div className="state-chips">
          {choices.map((c) => {
            const on = picked.has(keyOf(c.label));
            return (
              <button
                key={keyOf(c.label)}
                type="button"
                className={`state-chip${on ? " state-chip-on" : ""}`}
                aria-pressed={on}
                onClick={() => toggle(c)}
              >
                <span className="state-chip-glyph">{stateGlyph(c.icon)}</span>
                {c.label}
              </button>
            );
          })}
        </div>

        <div className="field" style={{ marginTop: 14 }}>
          <label className="label">Something else</label>
          <input
            className="input"
            placeholder="In your own words"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
          />
        </div>

        <div className="field">
          <label className="label">Anything to add?</label>
          <textarea
            className="input state-note"
            rows={2}
            placeholder="What was going on, how bad it was, what you'd eaten…"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>

        <div className="field">
          <label className="label">Felt at</label>
          <input
            className="input"
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
          />
        </div>

        {error && (
          <div className="error-text" style={{ marginBottom: 8 }}>
            {error}
          </div>
        )}

        <div className="btn-row">
          <button
            className="btn btn-primary btn-block"
            disabled={count === 0 || saving}
            onClick={() => void save()}
          >
            {saving ? <span className="spinner" /> : count > 1 ? `Log ${count} states` : "Log"}
          </button>
        </div>
      </div>
    </div>
  );
}
