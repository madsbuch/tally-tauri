/**
 * Rules for living: logging one coming up, and keeping the list.
 *
 * Built the way StateSheet is, for the same reason — using the list and
 * keeping it are different jobs. Picking a rule and saying what set it off is
 * the thing done in the moment; writing a new one down, rewording one, or
 * putting one away happens in a sheet of its own.
 *
 * Rules are sentences, not labels, so they're picked from rows rather than
 * chips, and each row carries the two things worth seeing at a glance: how
 * often it has come up lately, and where belief in it is heading.
 *
 * Suggestions — rules the diary agent heard in a note without being told
 * they were rules — sit at the top of both sheets until they're kept or
 * dismissed (see lib/lifeRules.ts for why they wait).
 */
import { useEffect, useState } from "react";
import {
  addLifeRule,
  addLifeRuleLog,
  deleteLifeRule,
  deleteLifeRuleLog,
  findLifeRuleByText,
  listAllLifeRuleLogs,
  listLifeRules,
  todayStr,
  updateLifeRule,
  updateLifeRuleLog,
} from "../lib/db";
import { notifyDiaryChanged } from "../lib/agent";
import { isoFromLocal, shiftDay, timeOf } from "../lib/daystamp";
import { ACTED_ON_LABEL, RULE_GLYPH } from "../lib/lifeRules";
import { useSheetHistory } from "../lib/sheetHistory";
import type { LifeRule, LifeRuleLog, RuleActedOn } from "../lib/types";
import { errMsg } from "./EntryBits";

const RECENT_DAYS = 30;

// ---------------------------------------------------------------------------
// Bits shared by logging and editing a moment
// ---------------------------------------------------------------------------

/** How a rule has been doing: times it came up lately, and its belief trend. */
interface RuleStats {
  recent: number;
  beliefs: number[];
}

function statsFor(logs: LifeRuleLog[]): Map<number, RuleStats> {
  const since = shiftDay(todayStr(), -RECENT_DAYS);
  const out = new Map<number, RuleStats>();
  for (const l of logs) {
    const s = out.get(l.rule_id) ?? { recent: 0, beliefs: [] };
    if (l.day >= since) s.recent++;
    if (l.belief !== null) s.beliefs.push(l.belief);
    out.set(l.rule_id, s);
  }
  return out;
}

/** The last dozen belief ratings as a line: is its grip loosening? */
function BeliefSpark({ values }: { values: number[] }) {
  const pts = values.slice(-12);
  if (pts.length < 2) return null;
  const w = 56;
  const h = 18;
  const step = w / (pts.length - 1);
  const d = pts.map((v, i) => `${(i * step).toFixed(1)},${(h - (v / 100) * h).toFixed(1)}`);
  return (
    <svg
      className="rule-spark"
      width={w}
      height={h}
      viewBox={`-1 -1 ${w + 2} ${h + 2}`}
      aria-label={`Belief over time: ${pts.join("%, ")}%`}
    >
      <polyline points={d.join(" ")} />
    </svg>
  );
}

function statsLine(s: RuleStats | undefined): string {
  if (!s || (s.recent === 0 && s.beliefs.length === 0)) return "Not logged yet";
  const parts = [s.recent === 0 ? `Not in ${RECENT_DAYS} days` : `${s.recent}× in ${RECENT_DAYS} days`];
  const last = s.beliefs[s.beliefs.length - 1];
  if (last !== undefined) parts.push(`last ${last}%`);
  return parts.join(" · ");
}

/** What set it off, how true it felt, whether they did what it said. */
function MomentFields({
  situation,
  setSituation,
  belief,
  setBelief,
  actedOn,
  setActedOn,
  time,
  setTime,
}: {
  situation: string;
  setSituation: (v: string) => void;
  belief: number | null;
  setBelief: (v: number | null) => void;
  actedOn: RuleActedOn | null;
  setActedOn: (v: RuleActedOn | null) => void;
  time: string;
  setTime: (v: string) => void;
}) {
  return (
    <>
      <div className="field">
        <label className="label">What set it off?</label>
        <textarea
          className="input state-note"
          rows={2}
          placeholder="Where you were, what happened, what you told yourself…"
          value={situation}
          onChange={(e) => setSituation(e.target.value)}
        />
      </div>

      <div className="field">
        <label className="label">
          How true did it feel?
          {belief !== null && <span className="rule-belief-value"> {belief}%</span>}
        </label>
        {belief === null ? (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setBelief(50)}>
            Rate it
          </button>
        ) : (
          <div className="rule-belief-row">
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={belief}
              onChange={(e) => setBelief(Number(e.target.value))}
              aria-label="Belief, percent"
            />
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              aria-label="Clear rating"
              onClick={() => setBelief(null)}
            >
              ✕
            </button>
          </div>
        )}
      </div>

      <div className="field">
        <label className="label">Did you do what it said?</label>
        <div className="seg">
          {(["yes", "partly", "no"] as const).map((v) => (
            <button
              key={v}
              type="button"
              className={actedOn === v ? "seg-item seg-item-active" : "seg-item"}
              aria-pressed={actedOn === v}
              onClick={() => setActedOn(actedOn === v ? null : v)}
            >
              {ACTED_ON_LABEL[v]}
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <label className="label">When</label>
        <input
          className="input"
          type="time"
          value={time}
          onChange={(e) => setTime(e.target.value)}
        />
      </div>
    </>
  );
}

/** A suggestion, with the two things you can do about it. */
function SuggestionRow({ rule, onChanged }: { rule: LifeRule; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  async function act(keep: boolean) {
    if (busy) return;
    setBusy(true);
    try {
      if (keep) await updateLifeRule(rule.id, { status: "kept" });
      else await deleteLifeRule(rule.id);
      notifyDiaryChanged();
      onChanged();
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="list-row rule-suggestion">
      <div className="row-main">
        <div className="rule-text">“{rule.text}”</div>
        <div className="row-sub">Heard in a note — is this one of yours?</div>
        <RuleSuggestionButtons busy={busy} onKeep={() => void act(true)} onDismiss={() => void act(false)} />
      </div>
    </div>
  );
}

/** Keep / Dismiss, also used inline on the diary timeline. */
export function RuleSuggestionButtons({
  busy,
  onKeep,
  onDismiss,
}: {
  busy: boolean;
  onKeep: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="rule-suggestion-actions">
      <button
        className="btn btn-primary btn-sm"
        disabled={busy}
        onClick={(e) => {
          e.stopPropagation();
          onKeep();
        }}
      >
        Keep
      </button>
      <button
        className="btn btn-ghost btn-sm"
        disabled={busy}
        onClick={(e) => {
          e.stopPropagation();
          onDismiss();
        }}
      >
        Dismiss
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One rule: its words, and the rule to practise instead
// ---------------------------------------------------------------------------

export function RuleEditSheet({
  rule,
  onClose,
  onChanged,
}: {
  rule: LifeRule;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [text, setText] = useState(rule.text);
  const [alternative, setAlternative] = useState(rule.alternative ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
      notifyDiaryChanged();
      onChanged();
      onClose();
    } catch (e) {
      setError(errMsg(e));
      setBusy(false);
    }
  }

  const save = () =>
    run(() =>
      updateLifeRule(rule.id, {
        text,
        alternative,
        // Editing a suggestion is taking it on.
        ...(rule.status === "suggested" ? { status: "kept" as const } : {}),
      }),
    );

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        <h2 className="sheet-title">
          {rule.status === "suggested" ? "Suggested rule" : "Rule for living"}
        </h2>

        <div className="field">
          <label className="label">The rule, in your words</label>
          <textarea
            className="input state-note"
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
        <div className="field">
          <label className="label">What you'd rather live by</label>
          <textarea
            className="input state-note"
            rows={2}
            placeholder="Optional — e.g. good enough is good enough"
            value={alternative}
            onChange={(e) => setAlternative(e.target.value)}
          />
        </div>
        <p className="faint small" style={{ margin: "0 2px 12px" }}>
          Times it came up keep the wording they were logged with.
        </p>

        {error && (
          <div className="error-text" style={{ marginBottom: 8 }}>
            {error}
          </div>
        )}

        <div className="btn-row">
          <button
            className="btn btn-primary btn-block"
            disabled={busy || !text.trim()}
            onClick={() => void save()}
          >
            {busy ? <span className="spinner" /> : rule.status === "suggested" ? "Keep" : "Save"}
          </button>
        </div>
        <div className="btn-row" style={{ marginTop: 8 }}>
          {rule.status === "suggested" ? (
            <button
              className="btn btn-ghost btn-block"
              disabled={busy}
              onClick={() => void run(() => deleteLifeRule(rule.id))}
            >
              Dismiss
            </button>
          ) : rule.status === "archived" ? (
            <button
              className="btn btn-ghost btn-block"
              disabled={busy}
              onClick={() => void run(() => updateLifeRule(rule.id, { status: "kept" }))}
            >
              Bring it back
            </button>
          ) : (
            <button
              className="btn btn-ghost btn-block"
              disabled={busy}
              onClick={() => void run(() => updateLifeRule(rule.id, { status: "archived" }))}
            >
              Put it away
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Keeping the list
// ---------------------------------------------------------------------------

function ManageRulesSheet({
  rules,
  stats,
  onClose,
  onChanged,
}: {
  rules: LifeRule[];
  stats: Map<number, RuleStats>;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<LifeRule | null>(null);

  useSheetHistory(editing !== null, () => setEditing(null));

  async function add() {
    const words = text.trim();
    if (!words || busy) return;
    setBusy(true);
    setError(null);
    try {
      // Typed in by hand, so it is theirs — a suggestion or an archived one
      // with the same words is simply taken back on.
      const known = await findLifeRuleByText(words);
      if (known) await updateLifeRule(known.id, { status: "kept" });
      else await addLifeRule({ text: words, status: "kept" });
      notifyDiaryChanged();
      await onChanged();
      setText("");
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  const suggested = rules.filter((r) => r.status === "suggested");
  const kept = rules.filter((r) => r.status === "kept");
  const archived = rules.filter((r) => r.status === "archived");

  const row = (r: LifeRule) => (
    <button key={r.id} className="list-row rule-row" onClick={() => setEditing(r)}>
      <div className="row-main">
        <div className="rule-text">“{r.text}”</div>
        {r.alternative && <div className="row-sub">Instead: {r.alternative}</div>}
        <div className="row-sub">{statsLine(stats.get(r.id))}</div>
      </div>
      <BeliefSpark values={stats.get(r.id)?.beliefs ?? []} />
      <div className="row-end">›</div>
    </button>
  );

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        <h2 className="sheet-title">Your rules</h2>

        <div className="field">
          <textarea
            className="input state-note"
            rows={2}
            placeholder="Write one down as it sounds in your head — I must always…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={busy}
          />
        </div>
        <div className="btn-row" style={{ marginBottom: 14 }}>
          <button
            className="btn btn-primary btn-block"
            onClick={() => void add()}
            disabled={busy || !text.trim()}
          >
            {busy ? <span className="spinner" /> : "Add rule"}
          </button>
        </div>

        {suggested.length > 0 && (
          <>
            <div className="label rule-section">Suggested</div>
            <div className="list">
              {suggested.map((r) => (
                <SuggestionRow key={r.id} rule={r} onChanged={() => void onChanged()} />
              ))}
            </div>
          </>
        )}

        {kept.length === 0 && suggested.length === 0 ? (
          <div className="empty">
            <div className="empty-icon">{RULE_GLYPH}</div>
            No rules written down yet.
          </div>
        ) : (
          kept.length > 0 && (
            <>
              <div className="label rule-section">Yours</div>
              <div className="list">{kept.map(row)}</div>
            </>
          )
        )}

        {archived.length > 0 && (
          <>
            <div className="label rule-section">Put away</div>
            <div className="list">{archived.map(row)}</div>
          </>
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

        {editing && (
          <RuleEditSheet
            rule={editing}
            onClose={() => setEditing(null)}
            onChanged={() => void onChanged()}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// A time it came up, opened from the diary
// ---------------------------------------------------------------------------

export function RuleLogSheet({
  log,
  onClose,
  onChanged,
}: {
  log: LifeRuleLog;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [situation, setSituation] = useState(log.situation ?? "");
  const [belief, setBelief] = useState<number | null>(log.belief);
  const [actedOn, setActedOn] = useState<RuleActedOn | null>(log.acted_on);
  const [time, setTime] = useState(() => timeOf(log.logged_at, log.tz_offset_min));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
      notifyDiaryChanged();
      onChanged();
      onClose();
    } catch (e) {
      setError(errMsg(e));
      setBusy(false);
    }
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        <h2 className="sheet-title">A rule came up</h2>
        <div className="rule-text rule-text-lead">“{log.rule_text}”</div>

        <MomentFields
          situation={situation}
          setSituation={setSituation}
          belief={belief}
          setBelief={setBelief}
          actedOn={actedOn}
          setActedOn={setActedOn}
          time={time}
          setTime={setTime}
        />

        {error && (
          <div className="error-text" style={{ marginBottom: 8 }}>
            {error}
          </div>
        )}

        <div className="btn-row">
          <button
            className="btn btn-primary btn-block"
            disabled={busy}
            onClick={() =>
              void run(() =>
                updateLifeRuleLog({
                  ...log,
                  situation,
                  belief,
                  acted_on: actedOn,
                  logged_at: isoFromLocal(log.day, time, log.tz_offset_min),
                }),
              )
            }
          >
            {busy ? <span className="spinner" /> : "Save"}
          </button>
        </div>
        <div className="btn-row" style={{ marginTop: 8 }}>
          <button
            className="btn btn-ghost btn-block"
            disabled={busy}
            onClick={() => void run(() => deleteLifeRuleLog(log.id))}
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Using it
// ---------------------------------------------------------------------------

export default function RuleSheet({
  day,
  onClose,
  onLogged,
}: {
  /** The diary day being added to — today, or one being looked back at. */
  day: string;
  onClose: () => void;
  onLogged: () => void;
}) {
  const [rules, setRules] = useState<LifeRule[]>([]);
  const [stats, setStats] = useState<Map<number, RuleStats>>(new Map());
  const [picked, setPicked] = useState<number | null>(null);
  const [situation, setSituation] = useState("");
  const [belief, setBelief] = useState<number | null>(null);
  const [actedOn, setActedOn] = useState<RuleActedOn | null>(null);
  const [time, setTime] = useState(() => timeOf(new Date().toISOString()));
  const [managing, setManaging] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useSheetHistory(managing, () => setManaging(false));

  async function load(): Promise<void> {
    const [rows, logs] = await Promise.all([listLifeRules(), listAllLifeRuleLogs()]);
    setRules(rows);
    setStats(statsFor(logs));
    // A rule put away or dismissed can't stay selected underneath.
    setPicked((prev) =>
      rows.some((r) => r.id === prev && r.status === "kept") ? prev : null,
    );
  }

  useEffect(() => {
    load().catch((e) => setError(errMsg(e)));
  }, []);

  async function save() {
    const rule = rules.find((r) => r.id === picked);
    if (!rule || saving) return;
    setSaving(true);
    setError(null);
    try {
      await addLifeRuleLog({
        rule,
        situation,
        belief,
        actedOn,
        loggedAt: isoFromLocal(day, time),
      });
      onLogged();
    } catch (e) {
      setError(errMsg(e));
      setSaving(false);
    }
  }

  const suggested = rules.filter((r) => r.status === "suggested");
  const kept = rules.filter((r) => r.status === "kept");

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        <div className="state-head">
          <h2 className="sheet-title" style={{ margin: 0 }}>
            A rule came up
          </h2>
          <button className="btn btn-ghost btn-sm" onClick={() => setManaging(true)}>
            Your rules
          </button>
        </div>

        {suggested.length > 0 && (
          <div className="list" style={{ marginBottom: 12 }}>
            {suggested.map((r) => (
              <SuggestionRow key={r.id} rule={r} onChanged={() => void load()} />
            ))}
          </div>
        )}

        {kept.length === 0 ? (
          <p className="muted small" style={{ margin: 0 }}>
            No rules written down yet. Add one under Your rules — or just tell the
            diary: “new rule: I must always…”.
          </p>
        ) : (
          <div className="list">
            {kept.map((r) => {
              const on = picked === r.id;
              return (
                <button
                  key={r.id}
                  type="button"
                  className={`list-row rule-row${on ? " rule-row-on" : ""}`}
                  aria-pressed={on}
                  onClick={() => {
                    setPicked(on ? null : r.id);
                    setError(null);
                  }}
                >
                  <div className="row-main">
                    <div className="rule-text">“{r.text}”</div>
                    <div className="row-sub">{statsLine(stats.get(r.id))}</div>
                  </div>
                  <BeliefSpark values={stats.get(r.id)?.beliefs ?? []} />
                </button>
              );
            })}
          </div>
        )}

        {picked !== null && (
          <div style={{ marginTop: 14 }}>
            <MomentFields
              situation={situation}
              setSituation={setSituation}
              belief={belief}
              setBelief={setBelief}
              actedOn={actedOn}
              setActedOn={setActedOn}
              time={time}
              setTime={setTime}
            />
          </div>
        )}

        {error && (
          <div className="error-text" style={{ marginBottom: 8 }}>
            {error}
          </div>
        )}

        <div className="btn-row" style={{ marginTop: 14 }}>
          <button
            className="btn btn-primary btn-block"
            disabled={picked === null || saving}
            onClick={() => void save()}
          >
            {saving ? <span className="spinner" /> : "Log"}
          </button>
        </div>

        {managing && (
          <ManageRulesSheet
            rules={rules}
            stats={stats}
            onClose={() => setManaging(false)}
            onChanged={load}
          />
        )}
      </div>
    </div>
  );
}
