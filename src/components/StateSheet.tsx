/**
 * Logging an observation: a feeling, something the body did, a thought that
 * came up. It started as "how do you feel?" and turned out to be the place
 * for anything noticed about yourself, so it is named for that now.
 *
 * The thing this has to get right is the moment it's used in. Nobody opens
 * their phone to describe being bloated, or to write a paragraph about a
 * depressive afternoon — so the sheet is one tap deep: the things you watch
 * are chips, tapping one selects it, Log saves. The note and the time are
 * there when the moment deserves them and skipped when it doesn't.
 *
 * Which means the chips must be one kind of thing and nothing else. An
 * earlier version put "＋ New" in the row beside them and had an Edit mode
 * that turned the same chips into delete buttons: three behaviours on one
 * control, and a form that opened inline with no way back out of it. Keeping
 * the list is a different job from using it, so it happens in a sheet of its
 * own — which the back button can leave, like every other sheet in the app.
 *
 * The chips are tags, and an observation can carry several: "bloated, farty
 * and snacky after lunch" is one moment with one story, and splitting it into
 * three rows with the same note copied onto each records something nobody
 * said. Writing a note and tapping nothing is fine too: the model tags it
 * from your list after Log (lib/observationTags.ts). Tags you tap yourself
 * are final; it never adds to them.
 */
import { useEffect, useState } from "react";
import {
  addStateCategory,
  addStateLog,
  deleteStateCategory,
  getSetting,
  listStateCategories,
  setStateLogTags,
} from "../lib/db";
import { tagObservation } from "../lib/observationTags";
import { isoFromLocal, timeOf } from "../lib/daystamp";
import { suggestStateIcon } from "../lib/openrouter";
import { useSheetHistory } from "../lib/sheetHistory";
import { STATE_FALLBACK_GLYPH, stateGlyph, stateKey } from "../lib/states";
import { DEFAULT_VISION_MODEL, SETTING_KEYS } from "../lib/types";
import type { StateCategory, StateLog, StateTag } from "../lib/types";
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
 * The observations you watch, as a list you can add to and take from.
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
        <h2 className="sheet-title">Your tags</h2>

        <div className="state-new-row">
          <input
            className="input"
            placeholder="Name one: ears ringing, restless legs, a thought…"
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
// The chips
// ---------------------------------------------------------------------------

/** The tags on their list, any number of them on. */
function TagChips({
  categories,
  picked,
  onToggle,
}: {
  categories: StateCategory[];
  picked: ReadonlySet<number>;
  onToggle: (c: StateCategory) => void;
}) {
  if (categories.length === 0) {
    return (
      <p className="muted small" style={{ margin: 0 }}>
        No tags on your list yet. Add one under Manage.
      </p>
    );
  }
  return (
    <div className="state-chips">
      {categories.map((c) => {
        const on = picked.has(c.id);
        return (
          <button
            key={c.id}
            type="button"
            className={`state-chip${on ? " state-chip-on" : ""}`}
            aria-pressed={on}
            onClick={() => onToggle(c)}
          >
            <span className="state-chip-glyph">{c.icon}</span>
            {c.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The list, what's picked from it, and the Manage sheet on top — shared by
 * logging a new observation and retagging one.
 */
function useTagPicker(initial: readonly StateTag[] = []) {
  const [categories, setCategories] = useState<StateCategory[]>([]);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [managing, setManaging] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  // The manage sheet is a layer of its own, so back leaves it and lands here
  // rather than closing everything.
  useSheetHistory(managing, () => setManaging(false));

  async function load(first = false): Promise<void> {
    const rows = await listStateCategories();
    setCategories(rows);
    setLoaded(true);
    setPicked((prev) => {
      if (first) {
        const keys = new Set(initial.map((t) => stateKey(t.label)));
        return new Set(rows.filter((r) => keys.has(stateKey(r.label))).map((r) => r.id));
      }
      // A tag taken off the list can't stay selected underneath.
      return new Set([...prev].filter((id) => rows.some((r) => r.id === id)));
    });
  }

  useEffect(() => {
    load(true).catch((e) => setLoadError(errMsg(e)));
    // Once, on open: `initial` is only what the observation had then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggle(c: StateCategory) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(c.id)) next.delete(c.id);
      else next.add(c.id);
      return next;
    });
  }

  /** Picked tags in list order, as they'll be stored. */
  const tags: StateTag[] = categories
    .filter((c) => picked.has(c.id))
    .map((c) => ({ label: c.label, icon: c.icon }));

  const manageSheet = managing ? (
    <ManageStatesSheet
      categories={categories}
      onClose={() => setManaging(false)}
      onChanged={() => load()}
    />
  ) : null;

  return {
    categories,
    loaded,
    picked,
    toggle,
    tags,
    loadError,
    openManage: () => setManaging(true),
    manageSheet,
  };
}

// ---------------------------------------------------------------------------
// Retagging one
// ---------------------------------------------------------------------------

/**
 * Change the tags on an observation already logged. Tags they set here are
 * theirs, so this also ends any tagging the model was still doing.
 */
export function ObservationTagsSheet({
  log,
  onClose,
  onSaved,
}: {
  log: StateLog;
  onClose: () => void;
  onSaved: () => void;
}) {
  const picker = useTagPicker(log.tags);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Tags no longer on their list stay on the record of the day unless taken
  // off here; they just can't be put back on.
  const [kept, setKept] = useState<StateTag[] | null>(null);
  useEffect(() => {
    if (!picker.loaded || kept !== null) return;
    const listKeys = new Set(picker.categories.map((c) => stateKey(c.label)));
    setKept(log.tags.filter((t) => !listKeys.has(stateKey(t.label))));
  }, [picker.loaded, picker.categories, kept, log.tags]);

  async function save() {
    if (kept === null) return;
    setSaving(true);
    setError(null);
    try {
      await setStateLogTags(log.id, [...picker.tags, ...kept], null);
      onSaved();
    } catch (e) {
      setError(errMsg(e));
      setSaving(false);
    }
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        <div className="state-head">
          <h2 className="sheet-title" style={{ margin: 0 }}>
            Tags
          </h2>
          <button className="btn btn-ghost btn-sm" onClick={picker.openManage}>
            Manage
          </button>
        </div>

        <TagChips categories={picker.categories} picked={picker.picked} onToggle={picker.toggle} />

        {kept && kept.length > 0 && (
          <div className="state-chips" style={{ marginTop: 10 }}>
            {kept.map((t) => (
              <button
                key={t.label}
                type="button"
                className="state-chip state-chip-on"
                aria-label={`Remove ${t.label}`}
                onClick={() => setKept((k) => (k ?? []).filter((x) => x !== t))}
              >
                <span className="state-chip-glyph">{stateGlyph(t.icon)}</span>
                {t.label} ✕
              </button>
            ))}
          </div>
        )}

        {(error ?? picker.loadError) && (
          <div className="error-text" style={{ marginTop: 10 }}>
            {error ?? picker.loadError}
          </div>
        )}

        <div className="btn-row" style={{ marginTop: 16 }}>
          <button
            className="btn btn-primary btn-block"
            disabled={saving || kept === null}
            onClick={() => void save()}
          >
            {saving ? <span className="spinner" /> : "Save"}
          </button>
        </div>

        {picker.manageSheet}
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
  const picker = useTagPicker();
  const [note, setNote] = useState("");
  const [time, setTime] = useState(() => timeOf(new Date().toISOString()));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasNote = note.trim() !== "";
  const canLog = picker.tags.length > 0 || hasNote;
  // Written but not tagged: the model picks the tags after Log.
  const autoTag = picker.tags.length === 0 && hasNote;

  async function save() {
    if (!canLog || saving) return;
    setSaving(true);
    setError(null);
    try {
      const id = await addStateLog({
        tags: picker.tags,
        note,
        tagging: autoTag ? "pending" : null,
        loggedAt: isoFromLocal(day, time),
      });
      if (autoTag) void tagObservation(id);
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
        <div className="state-head">
          <h2 className="sheet-title" style={{ margin: 0 }}>
            What do you notice?
          </h2>
          <button className="btn btn-ghost btn-sm" onClick={picker.openManage}>
            Manage
          </button>
        </div>

        <TagChips categories={picker.categories} picked={picker.picked} onToggle={picker.toggle} />

        <div className="field" style={{ marginTop: 14 }}>
          <label className="label">Anything to add?</label>
          <textarea
            className="input state-note"
            rows={2}
            placeholder="What was going on, how bad it was, the thought itself…"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          {autoTag && picker.categories.length > 0 && (
            <p className="faint small" style={{ margin: "6px 2px 0" }}>
              No tags picked: they'll be picked from your note.
            </p>
          )}
        </div>

        <div className="field">
          <label className="label">Noticed at</label>
          <input
            className="input"
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
          />
        </div>

        {(error ?? picker.loadError) && (
          <div className="error-text" style={{ marginBottom: 8 }}>
            {error ?? picker.loadError}
          </div>
        )}

        <div className="btn-row">
          <button
            className="btn btn-primary btn-block"
            disabled={!canLog || saving}
            onClick={() => void save()}
          >
            {saving ? <span className="spinner" /> : "Log"}
          </button>
        </div>

        {picker.manageSheet}
      </div>
    </div>
  );
}
