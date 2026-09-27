/**
 * Logging how you feel.
 *
 * The thing this has to get right is the moment it's used in. Nobody opens
 * their phone to describe being bloated, or to write a paragraph about a
 * depressive afternoon — so the whole sheet is one tap deep: the states you
 * watch are already chips, tapping one selects it, and Log saves. The note
 * and the time are there when the moment deserves them and skipped when it
 * doesn't.
 *
 * The chips are a list you own rather than a vocabulary the app ships. Adding
 * to it is the same one tap plus a name, and the emoji is the model's job,
 * because a state someone invents — "ears ringing", "restless legs" — was
 * never going to be in a table written in advance.
 *
 * Several at once is the normal case rather than a special one — tired AND
 * bloated AND irritable is one moment, not three trips through a form — and
 * each becomes its own row, so a state can be counted across weeks without
 * unpicking a sentence.
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
import { STATE_FALLBACK_GLYPH, stateKey } from "../lib/states";
import { DEFAULT_VISION_MODEL, SETTING_KEYS } from "../lib/types";
import type { StateCategory } from "../lib/types";
import { errMsg } from "./EntryBits";

/** The emoji for a state nobody has named before; the model usually finds one. */
async function iconFor(label: string): Promise<string> {
  const apiKey = await getSetting(SETTING_KEYS.openrouterApiKey);
  if (!apiKey) return STATE_FALLBACK_GLYPH;
  const model = (await getSetting(SETTING_KEYS.visionModel)) || DEFAULT_VISION_MODEL;
  return (await suggestStateIcon(apiKey, model, label)) ?? STATE_FALLBACK_GLYPH;
}

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
  const [adding, setAdding] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load(): Promise<StateCategory[]> {
    const rows = await listStateCategories();
    setCategories(rows);
    return rows;
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

  async function create() {
    const label = newLabel.trim();
    if (!label || creating) return;
    setCreating(true);
    setError(null);
    try {
      // An existing one comes back as-is, so typing a name you already have
      // selects it rather than filling the list with near-duplicates.
      const known = categories.find((c) => stateKey(c.label) === stateKey(label));
      const cat = known ?? (await addStateCategory(label, await iconFor(label)));
      await load();
      setPicked((prev) => new Set(prev).add(cat.id));
      setNewLabel("");
      setAdding(false);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setCreating(false);
    }
  }

  async function remove(c: StateCategory) {
    setError(null);
    try {
      await deleteStateCategory(c.id);
      setPicked((prev) => {
        const next = new Set(prev);
        next.delete(c.id);
        return next;
      });
      const rows = await load();
      if (rows.length === 0) setEditing(false);
    } catch (e) {
      setError(errMsg(e));
    }
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
          {categories.length > 0 && (
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setEditing((v) => !v);
                setAdding(false);
              }}
            >
              {editing ? "Done" : "Edit"}
            </button>
          )}
        </div>

        <div className="state-chips">
          {categories.map((c) => {
            const on = picked.has(c.id);
            return (
              <button
                key={c.id}
                type="button"
                className={`state-chip${on && !editing ? " state-chip-on" : ""}`}
                aria-pressed={editing ? undefined : on}
                onClick={() => (editing ? void remove(c) : toggle(c))}
              >
                <span className="state-chip-glyph">{c.icon}</span>
                {c.label}
                {editing && <span className="state-chip-x">✕</span>}
              </button>
            );
          })}
          {!editing && (
            <button
              type="button"
              className="state-chip state-chip-new"
              onClick={() => setAdding(true)}
            >
              ＋ New
            </button>
          )}
        </div>

        {adding && (
          <div className="state-new-row">
            <input
              className="input"
              autoFocus
              placeholder="Name it — ears ringing, restless legs…"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void create();
                }
              }}
              disabled={creating}
            />
            <button
              className="btn btn-primary"
              onClick={() => void create()}
              disabled={creating || !newLabel.trim()}
            >
              {creating ? <span className="spinner" /> : "Add"}
            </button>
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
      </div>
    </div>
  );
}
