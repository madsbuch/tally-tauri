/**
 * Coach stance: what it pushes for, and how it talks.
 *
 * Priorities are a ranked list rather than a set, because a coach with six
 * equal goals has none — the order is what the model uses to break ties.
 * Everything here is what the user declared; what the coach worked out for
 * itself lives in its memory below, shown so it can be checked and deleted.
 */
import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_STANCE,
  LENGTH_LABELS,
  TONE_LABELS,
  loadCoachStance,
  saveCoachStance,
} from "../lib/coach";
import type { CoachLength, CoachStance, CoachTone } from "../lib/coach";
import { deleteCoachMemory, listCoachMemory } from "../lib/db";
import type { CoachMemory } from "../lib/types";

const MAX_IMPERATIVES = 5;
const MAX_AVOID = 10;

const MEMORY_LABELS: Record<CoachMemory["kind"], string> = {
  goal: "Goal",
  commitment: "Commitment",
  preference: "Preference",
  note: "Note",
};

/** An ordered list of short strings with add, remove and promote. */
function RankedList({
  items,
  max,
  placeholder,
  ordered,
  onChange,
}: {
  items: string[];
  max: number;
  placeholder: string;
  ordered: boolean;
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState("");

  function add() {
    const t = draft.trim();
    if (!t || items.length >= max) return;
    setDraft("");
    onChange([...items, t]);
  }

  return (
    <>
      {items.length > 0 && (
        <div className="list" style={{ marginBottom: 8 }}>
          {items.map((item, i) => (
            <div key={`${item}-${i}`} className="list-row">
              <div className="row-main">
                <div className="row-title" style={{ whiteSpace: "normal" }}>
                  {ordered ? `${i + 1}. ${item}` : item}
                </div>
              </div>
              {ordered && i > 0 && (
                <button
                  className="btn btn-ghost btn-sm"
                  aria-label={`Move "${item}" up`}
                  onClick={() => {
                    const next = [...items];
                    const [moved] = next.splice(i, 1);
                    if (moved !== undefined) next.splice(i - 1, 0, moved);
                    onChange(next);
                  }}
                >
                  ↑
                </button>
              )}
              <button
                className="btn btn-ghost btn-sm"
                aria-label={`Remove "${item}"`}
                onClick={() => onChange(items.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      {items.length < max && (
        <div className="input-row" style={{ alignItems: "center" }}>
          <input
            className="input"
            value={draft}
            placeholder={placeholder}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
          />
          <button
            className="btn btn-sm"
            style={{ flex: "0 0 auto" }}
            disabled={!draft.trim()}
            onClick={add}
          >
            Add
          </button>
        </div>
      )}
    </>
  );
}

export default function CoachSettings() {
  const [stance, setStance] = useState<CoachStance>(DEFAULT_STANCE);
  const [memory, setMemory] = useState<CoachMemory[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState(false);
  const savedTimer = useRef<number | null>(null);

  useEffect(() => {
    void loadCoachStance().then((s) => {
      setStance(s);
      setLoaded(true);
    });
    void listCoachMemory().then(setMemory).catch(() => setMemory([]));
    return () => {
      if (savedTimer.current != null) window.clearTimeout(savedTimer.current);
    };
  }, []);

  /** Persist immediately — every control here is a discrete choice. */
  function commit(next: CoachStance) {
    setStance(next);
    void saveCoachStance(next).then(() => {
      setSaved(true);
      if (savedTimer.current != null) window.clearTimeout(savedTimer.current);
      savedTimer.current = window.setTimeout(() => setSaved(false), 1500);
    });
  }

  async function removeMemory(id: number) {
    await deleteCoachMemory(id);
    setMemory(await listCoachMemory());
  }

  if (!loaded) return null;

  return (
    <>
      <div className="section-title" style={{ display: "flex", justifyContent: "space-between" }}>
        <span>Coach</span>
        {saved && <span className="chip chip-accent">Saved</span>}
      </div>

      <div className="card">
        <h2 className="card-title">What you want from it</h2>
        <p className="muted small" style={{ margin: "0 0 10px" }}>
          In priority order — the top one wins when two pull against each other.
          A coach chasing five things at once isn&apos;t coaching.
        </p>
        <RankedList
          items={stance.imperatives}
          max={MAX_IMPERATIVES}
          ordered
          placeholder="e.g. Get to 150 g protein a day"
          onChange={(imperatives) => commit({ ...stance, imperatives })}
        />
      </div>

      <div className="card">
        <h2 className="card-title">How it talks</h2>
        <div className="field">
          <label className="label">Tone</label>
          <div className="seg">
            {(["gentle", "straight", "tough"] as CoachTone[]).map((t) => (
              <button
                key={t}
                className={`seg-item${stance.tone === t ? " seg-item-active" : ""}`}
                onClick={() => commit({ ...stance, tone: t })}
              >
                {TONE_LABELS[t]}
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <label className="label">Length</label>
          <div className="seg">
            {(["brief", "normal", "thorough"] as CoachLength[]).map((l) => (
              <button
                key={l}
                className={`seg-item${stance.length === l ? " seg-item-active" : ""}`}
                onClick={() => commit({ ...stance, length: l })}
              >
                {LENGTH_LABELS[l]}
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <label className="label" htmlFor="coach-language">
            Language
          </label>
          <input
            id="coach-language"
            className="input"
            placeholder="Follows whatever you write"
            value={stance.language}
            onChange={(e) => setStance({ ...stance, language: e.target.value })}
            onBlur={() => commit({ ...stance, language: stance.language.trim() })}
          />
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label className="label" htmlFor="coach-notes">
            Anything else, in your words
          </label>
          <textarea
            id="coach-notes"
            className="input"
            rows={3}
            placeholder="e.g. I train fasted in the mornings, don't suggest breakfast."
            value={stance.notes}
            onChange={(e) => setStance({ ...stance, notes: e.target.value })}
            onBlur={() => commit({ ...stance, notes: stance.notes.trim() })}
          />
        </div>
      </div>

      <div className="card">
        <h2 className="card-title">Never bring up</h2>
        <p className="muted small" style={{ margin: "0 0 10px" }}>
          Subjects it must not raise, however relevant the data looks. It still
          answers if you ask directly.
        </p>
        <RankedList
          items={stance.avoid}
          max={MAX_AVOID}
          ordered={false}
          placeholder="e.g. my weight"
          onChange={(avoid) => commit({ ...stance, avoid })}
        />
      </div>

      <div className="card">
        <h2 className="card-title">What it remembers</h2>
        {memory.length === 0 ? (
          <p className="muted small" style={{ margin: 0 }}>
            Nothing yet. As you talk, the coach records goals, things you commit
            to, and how you like to be coached — it all shows up here, and you
            can delete any of it.
          </p>
        ) : (
          <div className="list">
            {memory.map((m) => (
              <div key={m.id} className="list-row">
                <div className="row-main">
                  <div className="row-title" style={{ whiteSpace: "normal" }}>
                    {m.text}
                  </div>
                  <div className="row-sub">
                    {MEMORY_LABELS[m.kind]}
                    {m.status ? ` · ${m.status}` : ""}
                  </div>
                </div>
                <button
                  className="btn btn-ghost btn-sm row-end"
                  aria-label="Forget this"
                  onClick={() => void removeMemory(m.id)}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
