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
  cacheCoachPromptPrefix,
  loadCoachStance,
  saveCoachStance,
} from "../lib/coach";
import type { CoachLength, CoachStance, CoachTone } from "../lib/coach";
import { deleteCoachMemory, listCoachMemory } from "../lib/db";
import type { CoachMemory } from "../lib/types";
import {
  DEFAULT_CHECKIN_HOUR,
  TRIGGERS,
  defaultTriggers,
  loadCheckinHour,
  loadCoachTriggers,
  saveCheckinHour,
  saveCoachTriggers,
  syncCoachSchedule,
} from "../lib/coachTriggers";
import type { CoachTriggers, TriggerKey } from "../lib/coachTriggers";
import { runCoachCheckin } from "../lib/coachCheckin";

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

/** Why a forced check-in produced nothing, in the user's terms. */
const CHECKIN_REASONS: Record<string, string> = {
  nothing: "Nothing worth raising right now — that's the coach working as intended.",
  cooldown: "Everything it would have raised, it raised recently. Give it a few days.",
  budget: "It has already spoken today.",
  "no-key": "Add your OpenRouter API key first.",
  busy: "A check-in is already running.",
  failed: "The check-in failed — check your connection and key.",
};

export default function CoachSettings() {
  const [stance, setStance] = useState<CoachStance>(DEFAULT_STANCE);
  const [triggers, setTriggers] = useState<CoachTriggers>(defaultTriggers);
  const [checkinHour, setCheckinHour] = useState(DEFAULT_CHECKIN_HOUR);
  const [memory, setMemory] = useState<CoachMemory[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState(false);
  const [checkingIn, setCheckingIn] = useState(false);
  const [checkinNote, setCheckinNote] = useState<string | null>(null);
  const savedTimer = useRef<number | null>(null);

  useEffect(() => {
    void loadCoachStance().then((s) => {
      setStance(s);
      setLoaded(true);
    });
    void loadCoachTriggers().then(setTriggers);
    void loadCheckinHour().then(setCheckinHour);
    void listCoachMemory().then(setMemory).catch(() => setMemory([]));
    return () => {
      if (savedTimer.current != null) window.clearTimeout(savedTimer.current);
    };
  }, []);

  function commitTriggers(next: CoachTriggers) {
    setTriggers(next);
    // Re-point the Android alarm: turning everything off should cancel it.
    void saveCoachTriggers(next).then(syncCoachSchedule).then(flashSaved);
  }

  function commitCheckinHour(hour: number) {
    if (!isFinite(hour)) return;
    const clamped = Math.min(23, Math.max(0, Math.round(hour)));
    setCheckinHour(clamped);
    void saveCheckinHour(clamped).then(syncCoachSchedule).then(flashSaved);
  }

  function patchTrigger(key: TriggerKey, patch: Partial<CoachTriggers[TriggerKey]>) {
    const current = triggers[key];
    commitTriggers({ ...triggers, [key]: { ...current, ...patch } });
  }

  async function checkInNow() {
    setCheckingIn(true);
    setCheckinNote(null);
    try {
      const r = await runCoachCheckin({ force: true });
      setCheckinNote(
        r.sent
          ? "Done — it's at the top of your chats."
          : (CHECKIN_REASONS[r.reason] ?? "Nothing to say right now."),
      );
      setMemory(await listCoachMemory());
    } finally {
      setCheckingIn(false);
    }
  }

  function flashSaved() {
    setSaved(true);
    if (savedTimer.current != null) window.clearTimeout(savedTimer.current);
    savedTimer.current = window.setTimeout(() => setSaved(false), 1500);
  }

  /** Persist immediately — every control here is a discrete choice. */
  function commit(next: CoachStance) {
    setStance(next);
    void saveCoachStance(next)
      .then(cacheCoachPromptPrefix)
      .then(flashSaved);
  }

  async function removeMemory(id: number) {
    await deleteCoachMemory(id);
    setMemory(await listCoachMemory());
    await cacheCoachPromptPrefix();
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
        <h2 className="card-title">When it speaks up</h2>
        <p className="muted small" style={{ margin: "0 0 10px" }}>
          At most one check-in a day, whatever fires — and each of these waits
          days before raising the same thing twice. When several are true at
          once, the coach opens with the most useful one and folds the rest in.
        </p>
        {TRIGGERS.map((t) => {
          const c = triggers[t.key];
          return (
            <div key={t.key} className="field">
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                }}
              >
                <label className="label" style={{ margin: 0 }}>
                  {t.title}
                </label>
                <div className="seg" style={{ flex: "0 0 auto", padding: 2, gap: 2 }}>
                  {[false, true].map((on) => (
                    <button
                      key={String(on)}
                      className={`seg-item${c.enabled === on ? " seg-item-active" : ""}`}
                      style={{ flex: "0 0 auto", padding: "4px 12px", fontSize: 12 }}
                      onClick={() => patchTrigger(t.key, { enabled: on })}
                    >
                      {on ? "On" : "Off"}
                    </button>
                  ))}
                </div>
              </div>
              <p className="muted small" style={{ margin: "6px 2px 0" }}>
                {t.help}
              </p>
              {c.enabled && (t.hourLabel || t.thresholdLabel) && (
                <div className="input-row" style={{ marginTop: 8 }}>
                  {t.hourLabel && (
                    <div>
                      <label className="label">{t.hourLabel}</label>
                      <input
                        className="input"
                        type="number"
                        min={0}
                        max={23}
                        inputMode="numeric"
                        value={c.hour ?? 21}
                        onChange={(e) =>
                          patchTrigger(t.key, { hour: parseInt(e.target.value, 10) })
                        }
                      />
                    </div>
                  )}
                  {t.thresholdLabel && (
                    <div>
                      <label className="label">{t.thresholdLabel}</label>
                      <input
                        className="input"
                        type="number"
                        min={0}
                        step="any"
                        inputMode="decimal"
                        value={c.threshold ?? 0}
                        onChange={(e) =>
                          patchTrigger(t.key, { threshold: parseFloat(e.target.value) })
                        }
                      />
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
        <div className="field">
          <label className="label" htmlFor="coach-checkin-hour">
            Wake up and check in at
          </label>
          <div className="input-row" style={{ alignItems: "center" }}>
            <input
              id="coach-checkin-hour"
              className="input"
              type="number"
              min={0}
              max={23}
              inputMode="numeric"
              value={checkinHour}
              onChange={(e) => setCheckinHour(parseInt(e.target.value, 10) || 0)}
              onBlur={() => commitCheckinHour(checkinHour)}
            />
            <span className="faint small" style={{ flex: "0 0 auto" }}>
              :00
            </span>
          </div>
          <p className="muted small" style={{ margin: "8px 2px 0" }}>
            On Android the app wakes itself at this hour and checks in even when
            it&apos;s closed. Once a day, matching the one-message budget — the
            times above still apply as &quot;not before&quot; guards.
          </p>
        </div>
        <button
          className="btn btn-block"
          style={{ marginTop: 4 }}
          disabled={checkingIn}
          onClick={() => void checkInNow()}
        >
          {checkingIn ? <span className="spinner" /> : "Check in now"}
        </button>
        {checkinNote && (
          <p className="muted small" style={{ margin: "8px 2px 0" }}>
            {checkinNote}
          </p>
        )}
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
                    {m.follow_up_on ? ` · follows up ${m.follow_up_on}` : ""}
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
