/**
 * Logging how you feel.
 *
 * The thing this has to get right is the moment it's used in. Nobody opens
 * their phone to describe being bloated, or to write a paragraph about a
 * depressive afternoon — so the sheet is one tap deep: the states you watch
 * are chips, tapping one selects it, Log saves. The note and the time are
 * there when the moment deserves them and skipped when it doesn't.
 *
 * Which means the chips must be one kind of thing and nothing else. An
 * earlier version put "＋ New" in the row beside them and had an Edit mode
 * that turned the same chips into delete buttons: three behaviours on one
 * control, and a form that opened inline with no way back out of it. Keeping
 * the list is a different job from using it, so it happens in a sheet of its
 * own — which the back button can leave, like every other sheet in the app.
 */
import { useEffect, useState } from "react";
import {
  addStateCategory,
  addStateLog,
  deleteStateCategory,
  getSetting,
  listStateCategories,
} from "../lib/db";
import { isoFromLocal, timeOf } from "../lib/daystamp";
import { suggestStateIcon } from "../lib/openrouter";
import { useSheetHistory } from "../lib/sheetHistory";
import { STATE_FALLBACK_GLYPH, stateKey } from "../lib/states";
import { DEFAULT_VISION_MODEL, SETTING_KEYS } from "../lib/types";
import type { StateCategory } from "../lib/types";
import { GlyphThumb, errMsg } from "./EntryBits";

/** The emoji for a state nobody has named before; the model usually finds one. */
async function iconFor(label: string): Promise<string> {
  const apiKey = await getSetting(SETTING_KEYS.openrouterApiKey);
  if (!apiKey) return STATE_FALLBACK_GLYPH;
  const model = (await getSetting(SETTING_KEYS.visionModel)) || DEFAULT_VISION_MODEL;
  return (await suggestStateIcon(apiKey, model, label)) ?? STATE_FALLBACK_GLYPH;
}

// ---------------------------------------------------------------------------
// Keeping the list
// ---------------------------------------------------------------------------

/**
 * The states you watch, as a list you can add to and take from.
 *
 * A sheet rather than a mode: adding a category is a small errand you go off
 * on and come back from, and Cancel, Done and the back button all end it.
 */
function ManageStatesSheet({
  categories,
  onClose,
  onChanged,
}: {
  categories: StateCategory[];
  onClose: () => void;
  /** Reload the list upstairs; the picker is showing the same rows. */
  onChanged: () => Promise<void>;
}) {
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    const name = label.trim();
    if (!name || busy) return;
    setBusy(true);
    setError(null);
    try {
      // An existing one comes back as-is, so typing a name already on the
      // list is a no-op rather than a near-duplicate.
      const known = categories.find((c) => stateKey(c.label) === stateKey(name));
      if (!known) await addStateCategory(name, await iconFor(name));
      await onChanged();
      setLabel("");
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(c: StateCategory) {
    setError(null);
    try {
      await deleteStateCategory(c.id);
      await onChanged();
    } catch (e) {
      setError(errMsg(e));
    }
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        <h2 className="sheet-title">States you watch</h2>

        <div className="state-new-row">
          <input
            className="input"
            placeholder="Name one — ears ringing, restless legs…"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void add();
              }
            }}
            disabled={busy}
          />
          <button
            className="btn btn-primary"
            onClick={() => void add()}
            disabled={busy || !label.trim()}
          >
            {busy ? <span className="spinner" /> : "Add"}
          </button>
        </div>
        <p className="faint small" style={{ margin: "6px 2px 14px" }}>
          The icon is picked for you.
        </p>

        {categories.length === 0 ? (
          <div className="empty">
            <div className="empty-icon">💭</div>
            Nothing on the list yet.
          </div>
        ) : (
          <div className="list">
            {categories.map((c) => (
              <div key={c.id} className="list-row">
                <GlyphThumb glyph={c.icon} />
                <div className="row-main">
                  <div className="row-title">{c.label}</div>
                </div>
                <button
                  className="btn btn-ghost btn-sm"
                  aria-label={`Remove ${c.label}`}
                  onClick={() => void remove(c)}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        {error && (
          <div className="error-text" style={{ marginTop: 10 }}>
            {error}
          </div>
        )}

        <div className="btn-row" style={{ marginTop: 16 }}>
          <button className="btn btn-primary btn-block" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Using it
// ---------------------------------------------------------------------------

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
  const [categories, setCategories] = useState<StateCategory[]>([]);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [note, setNote] = useState("");
  const [time, setTime] = useState(() => timeOf(new Date().toISOString()));
  const [managing, setManaging] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The manage sheet is a layer of its own, so back leaves it and lands here
  // rather than closing everything.
  useSheetHistory(managing, () => setManaging(false));

  async function load(): Promise<void> {
    const rows = await listStateCategories();
    setCategories(rows);
    // A state taken off the list can't stay selected underneath.
    setPicked((prev) => new Set([...prev].filter((id) => rows.some((r) => r.id === id))));
  }

  useEffect(() => {
    load().catch((e) => setError(errMsg(e)));
  }, []);

  function toggle(c: StateCategory) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(c.id)) next.delete(c.id);
      else next.add(c.id);
      return next;
    });
    setError(null);
  }

  async function save() {
    const states = categories.filter((c) => picked.has(c.id));
    if (states.length === 0 || saving) return;
    setSaving(true);
    setError(null);
    try {
      const loggedAt = isoFromLocal(day, time);
      // One row each, sharing the moment and the note that came with it.
      for (const c of states) {
        await addStateLog({ label: c.label, icon: c.icon, note, loggedAt });
      }
      onLogged();
    } catch (e) {
      setError(errMsg(e));
      setSaving(false);
    }
  }

  const count = picked.size;

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        <div className="state-head">
          <h2 className="sheet-title" style={{ margin: 0 }}>
            How do you feel?
          </h2>
          <button className="btn btn-ghost btn-sm" onClick={() => setManaging(true)}>
            Manage
          </button>
        </div>

        {categories.length === 0 ? (
          <p className="muted small" style={{ margin: 0 }}>
            No states on your list yet — add one under Manage.
          </p>
        ) : (
          <div className="state-chips">
            {categories.map((c) => {
              const on = picked.has(c.id);
              return (
                <button
                  key={c.id}
                  type="button"
                  className={`state-chip${on ? " state-chip-on" : ""}`}
                  aria-pressed={on}
                  onClick={() => toggle(c)}
                >
                  <span className="state-chip-glyph">{c.icon}</span>
                  {c.label}
                </button>
              );
            })}
          </div>
        )}

        <div className="field" style={{ marginTop: 14 }}>
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

        {managing && (
          <ManageStatesSheet
            categories={categories}
            onClose={() => setManaging(false)}
            onChanged={load}
          />
        )}
      </div>
    </div>
  );
}
