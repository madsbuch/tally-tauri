import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Fast, FoodEntry, Manual } from "../lib/types";
import { DEFAULT_FAST_HOURS, SETTING_KEYS } from "../lib/types";
import { notifyDiaryChanged, onDiaryChanged } from "../lib/agent";
import {
  deleteFast,
  getActiveFast,
  getLastMealAt,
  getManualFor,
  getSetting,
  listAllFasts,
  listMealsSince,
  listRecentFasts,
  setFoodEntryFastOk,
  setSetting,
} from "../lib/db";
import {
  FASTING_STAGES,
  endFast,
  ensureNotificationPermission,
  fastEnd,
  fastProgress,
  fastingStageIndex,
  formatDuration,
  startFast,
} from "../lib/fasting";
import type { FastingStage } from "../lib/fasting";
import InfoButton from "../components/InfoButton";
import { MANUAL_GLYPH, manualPath, onManualsChanged } from "../lib/manuals";
import { useGo } from "../lib/navigation";

const PRESET_HOURS = [13, 16, 18, 24, 48, 72];
const MIN_HOURS = 1;
const MAX_HOURS = 168;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const RING_SIZE = 260;
const RING_STROKE = 14;

/** Meter: single-ratio progress ring. Track = border gray, fill = accent. */
function ProgressRing({
  fraction,
  children,
}: {
  fraction: number;
  children: React.ReactNode;
}) {
  const r = (RING_SIZE - RING_STROKE) / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.min(1, Math.max(0, fraction));
  const center = RING_SIZE / 2;
  return (
    <div style={{ position: "relative", width: RING_SIZE, height: RING_SIZE }}>
      <svg
        width={RING_SIZE}
        height={RING_SIZE}
        viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(clamped * 100)}
        aria-label="Fast progress"
      >
        <circle
          cx={center}
          cy={center}
          r={r}
          fill="none"
          stroke="var(--border)"
          strokeWidth={RING_STROKE}
        />
        <circle
          cx={center}
          cy={center}
          r={r}
          fill="none"
          stroke="var(--accent)"
          strokeWidth={RING_STROKE}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - clamped)}
          transform={`rotate(-90 ${center} ${center})`}
          style={{ transition: "stroke-dashoffset 0.6s ease" }}
        />
      </svg>
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {children}
      </div>
    </div>
  );
}

function formatStartStamp(iso: string): string {
  return new Date(iso).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Day-aware duration: under 24h delegates to formatDuration ("H:MM" /
 * "H:MM:SS"); at 24h and above prefixes whole days ("2d 23:47").
 */
function formatDurationDays(ms: number, withSeconds = false): string {
  const clamped = Math.max(0, ms);
  if (clamped < DAY_MS) return formatDuration(clamped, withSeconds);
  const days = Math.floor(clamped / DAY_MS);
  return `${days}d ${formatDuration(clamped - days * DAY_MS, withSeconds)}`;
}

/**
 * Stat-tile timestamp that always carries the day: "Sat 15:17" normally,
 * or "Jul 19 15:17" style when the fast spans more than 6 days (a weekday
 * name would be ambiguous).
 */
function formatDayStamp(date: Date, longSpan: boolean): string {
  return date.toLocaleString(
    [],
    longSpan
      ? { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }
      : { weekday: "short", hour: "numeric", minute: "2-digit" },
  );
}

/** Trim a trailing ".0" from a one-decimal number string. */
function oneDecimal(n: number): string {
  return n.toFixed(1).replace(/\.0$/, "");
}

/** History label: hours up to 48h ("36.0h"), days with one decimal above ("2.5d"). */
function formatAchieved(ms: number): string {
  const hours = ms / HOUR_MS;
  if (hours <= 48) return `${hours.toFixed(1)}h`;
  return `${oneDecimal(hours / 24)}d`;
}

/** "0–4h" range label for a stage, "72h+" for the open-ended last one. */
function stageHoursLabel(s: FastingStage): string {
  return s.toH == null ? `${s.fromH}h+` : `${s.fromH}–${s.toH}h`;
}

/** Lifetime fasting records, over COMPLETED fasts only. */
interface FastRecords {
  longestMs: number;
  totalHours: number;
  completed: number;
  goalsHit: number;
}

function computeRecords(all: Fast[]): FastRecords {
  let longestMs = 0;
  let totalMs = 0;
  let completed = 0;
  let goalsHit = 0;
  for (const f of all) {
    if (!f.ended_at) continue;
    const ms = Math.max(0, new Date(f.ended_at).getTime() - new Date(f.started_at).getTime());
    completed++;
    totalMs += ms;
    longestMs = Math.max(longestMs, ms);
    if (ms >= f.goal_hours * HOUR_MS - 1000) goalsHit++;
  }
  return { longestMs, totalHours: totalMs / HOUR_MS, completed, goalsHit };
}

/**
 * Autophagy & fasting stages as a strip you scroll sideways. Where you are —
 * the running fast, or the time since your last meal when there isn't one —
 * is highlighted and scrolled into the middle; what a stage means stays
 * folded away until you tap it, so the strip is one row high.
 */
function StageStrip({ elapsedMs }: { elapsedMs: number | null }) {
  const activeIdx = elapsedMs == null ? -1 : fastingStageIndex(elapsedMs / HOUR_MS);
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const stripRef = useRef<HTMLDivElement>(null);

  // Bring the current stage to the middle — instantly on first show, then
  // smoothly as the fast moves into the next one.
  const firstScroll = useRef(true);
  useEffect(() => {
    const strip = stripRef.current;
    const el = strip?.children[activeIdx] as HTMLElement | undefined;
    if (!strip || !el) return;
    strip.scrollTo({
      left: el.offsetLeft - (strip.clientWidth - el.clientWidth) / 2,
      behavior: firstScroll.current ? "auto" : "smooth",
    });
    firstScroll.current = false;
  }, [activeIdx]);

  const open = openIdx == null ? null : FASTING_STAGES[openIdx];
  const next = FASTING_STAGES[activeIdx + 1];
  return (
    <div className="card stage-card">
      <div className="stage-strip" ref={stripRef}>
        {FASTING_STAGES.map((s, i) => {
          const state = i < activeIdx ? "past" : i === activeIdx ? "now" : "ahead";
          return (
            <button
              key={s.fromH}
              type="button"
              className={`stage-pill stage-${state}${openIdx === i ? " stage-open" : ""}`}
              aria-expanded={openIdx === i}
              onClick={() => setOpenIdx(openIdx === i ? null : i)}
            >
              <span className="stage-emoji">{s.emoji}</span>
              <span className="stage-name">{s.title}</span>
              <span className="stage-hours">
                {state === "past" ? "✓ " : ""}
                {stageHoursLabel(s)}
              </span>
            </button>
          );
        })}
      </div>
      {elapsedMs != null && next && (
        <div className="small stage-next">
          Next: {next.emoji} {next.title} in{" "}
          {formatDurationDays(Math.max(0, next.fromH * HOUR_MS - elapsedMs))}
        </div>
      )}
      {open && (
        <div className="muted small stage-blurb" key={open.fromH}>
          <strong>{open.title}</strong> · {open.blurb}
        </div>
      )}
    </div>
  );
}

/**
 * The fasting half of the Body tab: the timer, its stages, records and
 * history. Rendered inside BodyPage, under what's in the body right now.
 */
export default function FastingSection() {
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState<Fast | null>(null);
  const [lastMealAt, setLastMealAt] = useState<string | null>(null);
  /** Fast-breaking meals tracked inside the active fast's window. */
  const [fastMeals, setFastMeals] = useState<FoodEntry[]>([]);
  /** The flagged meal being marked as not breaking the fast, and the reason typed so far. */
  const [exempting, setExempting] = useState<number | null>(null);
  const [exemptNote, setExemptNote] = useState("");
  const [savingExempt, setSavingExempt] = useState(false);
  const [history, setHistory] = useState<Fast[]>([]);
  const [allFasts, setAllFasts] = useState<Fast[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notifWarn, setNotifWarn] = useState(false);

  const [presetHours, setPresetHours] = useState<number>(DEFAULT_FAST_HOURS);
  const [customMode, setCustomMode] = useState(false);
  const [customHours, setCustomHours] = useState(String(DEFAULT_FAST_HOURS));
  /** What the next fast is for; the diary agent judges entries against it. */
  const [purpose, setPurpose] = useState("");

  const [starting, setStarting] = useState(false);
  const [ending, setEnding] = useState(false);
  const [now, setNow] = useState(() => new Date());
  /** The manual for fasting, shown as a way in while a fast runs. */
  const [manual, setManual] = useState<Manual | null>(null);
  const [manualVersion, setManualVersion] = useState(0);
  const go = useGo();

  useEffect(() => onManualsChanged(() => setManualVersion((n) => n + 1)), []);

  useEffect(() => {
    let alive = true;
    void getManualFor("fasting")
      .catch(() => null)
      .then((m) => {
        if (alive) setManual(m);
      });
    return () => {
      alive = false;
    };
  }, [manualVersion]);

  const loadHistory = useCallback(async () => {
    const [recent, all] = await Promise.all([listRecentFasts(30), listAllFasts()]);
    setHistory(recent);
    setAllFasts(all);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [fast, fasts, all, saved] = await Promise.all([
          getActiveFast(),
          listRecentFasts(30),
          listAllFasts(),
          getSetting(SETTING_KEYS.fastDefaultHours),
        ]);
        if (cancelled) return;
        setActive(fast);
        setHistory(fasts);
        setAllFasts(all);
        const savedHours = saved != null ? parseFloat(saved) : NaN;
        if (isFinite(savedHours) && savedHours >= MIN_HOURS && savedHours <= MAX_HOURS) {
          if (PRESET_HOURS.includes(savedHours)) {
            setPresetHours(savedHours);
          } else {
            setCustomMode(true);
            setCustomHours(String(savedHours));
          }
        }
      } catch {
        if (!cancelled) setError("Could not load fasting data.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 1s ticker while a fast is active; slow tick while idle so the
  // "time since last meal" label stays fresh.
  useEffect(() => {
    setNow(new Date());
    const id = window.setInterval(() => setNow(new Date()), active ? 1000 : 60_000);
    return () => window.clearInterval(id);
  }, [active]);

  // Meal-derived state: the anchor for the next fast and any meals tracked
  // inside the active fast's window. Refreshed when the diary changes (the
  // background capture agent resolves entries while this page is open).
  const refreshMealState = useCallback(async (fast: Fast | null) => {
    try {
      const [meals, lastMeal] = await Promise.all([
        fast ? listMealsSince(fast.started_at) : Promise.resolve([]),
        getLastMealAt(),
      ]);
      setFastMeals(meals);
      setLastMealAt(lastMeal);
    } catch (e) {
      console.warn("Could not refresh meal state", e);
    }
  }, []);

  useEffect(() => {
    void refreshMealState(active);
    return onDiaryChanged(() => void refreshMealState(active));
  }, [active, refreshMealState]);

  const parsedCustom = parseFloat(customHours);
  const customValid =
    isFinite(parsedCustom) && parsedCustom >= MIN_HOURS && parsedCustom <= MAX_HOURS;
  const chosenHours = customMode ? parsedCustom : presetHours;

  async function handleStart() {
    if (!isFinite(chosenHours) || chosenHours < MIN_HOURS || chosenHours > MAX_HOURS) {
      setError(`Goal must be between ${MIN_HOURS} and ${MAX_HOURS} hours.`);
      return;
    }
    setError(null);
    setNotifWarn(false);
    setStarting(true);
    try {
      await setSetting(SETTING_KEYS.fastDefaultHours, String(chosenHours));
      const fast = await startFast(chosenHours, purpose);
      setActive(fast);
      setPurpose("");
      if (!(await ensureNotificationPermission())) setNotifWarn(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start the fast.");
      // A fast may already be running (e.g. started elsewhere) — resync.
      try {
        setActive(await getActiveFast());
      } catch {
        /* keep the original error */
      }
    } finally {
      setStarting(false);
    }
  }

  /** Shared teardown; `endedAt` backdates the end (meal tracked mid-fast). */
  async function doEnd(fast: Fast, endedAt?: Date) {
    setError(null);
    setEnding(true);
    try {
      await endFast(fast, endedAt);
      // Clearing `active` retriggers refreshMealState — meals logged during
      // the fast become the anchor for the next one.
      setActive(null);
      setNotifWarn(false);
      await loadHistory();
    } catch {
      setError("Could not end the fast.");
    } finally {
      setEnding(false);
    }
  }

  async function handleEnd(fast: Fast, early: boolean) {
    if (
      early &&
      !window.confirm("End this fast before reaching your goal? It will be saved to history.")
    ) {
      return;
    }
    await doEnd(fast);
  }

  /** End the fast at the moment a mid-fast meal was eaten, not at "now". */
  async function handleEndAtMeal(fast: Fast, meal: FoodEntry) {
    const longSpan = fast.goal_hours > 6 * 24;
    // A future-dated entry still ends the fast, but not beyond "now".
    const when = new Date(Math.min(new Date(meal.eaten_at).getTime(), Date.now()));
    if (
      !window.confirm(
        `End this fast at ${formatDayStamp(when, longSpan)}, when "${meal.title}" was eaten? It will be saved to history.`,
      )
    ) {
      return;
    }
    await doEnd(fast, when);
  }

  /**
   * "This didn't break my fast": saves the reason on the entry, which exempts
   * that food (by title) from fasting checks from now on.
   */
  async function handleExempt(meal: FoodEntry) {
    setSavingExempt(true);
    setError(null);
    try {
      await setFoodEntryFastOk(meal.id, exemptNote.trim() || "Doesn't break a fast");
      setExempting(null);
      setExemptNote("");
      // Refreshes this card too (it listens), plus anything else showing the diary.
      notifyDiaryChanged();
    } catch {
      setError("Could not save that.");
    } finally {
      setSavingExempt(false);
    }
  }

  async function handleDelete(id: number) {
    if (!window.confirm("Delete this fast from history?")) return;
    setError(null);
    try {
      await deleteFast(id);
      setHistory((prev) => prev.filter((f) => f.id !== id));
      setAllFasts((prev) => prev.filter((f) => f.id !== id));
    } catch {
      setError("Could not delete the fast.");
    }
  }

  // Hooks must run on every render — keep this above the loading return.
  const records = useMemo(() => computeRecords(allFasts), [allFasts]);

  if (loading) {
    return (
      <>
        <div className="section-title">Fasting</div>
        <div className="empty" style={{ display: "flex", justifyContent: "center" }}>
          <span className="spinner" />
        </div>
      </>
    );
  }

  // Time since the last real meal (see getLastMealAt) — the fast already running.
  const lastMealMs = lastMealAt ? now.getTime() - new Date(lastMealAt).getTime() : null;

  let body: React.ReactNode;
  if (active) {
    const prog = fastProgress(active, now);
    const end = fastEnd(active);
    const overtimeMs = Math.max(0, prog.elapsedMs - active.goal_hours * HOUR_MS);
    const longSpan = active.goal_hours > 6 * 24;
    const stage = FASTING_STAGES[fastingStageIndex(prog.elapsedMs / HOUR_MS)];
    // Oldest fast-breaking meal tracked inside the window — the honest end
    // time if the fast was actually broken.
    const flaggedMeal = fastMeals[0];
    const goalLabel =
      active.goal_hours >= 48
        ? `of ${active.goal_hours}h goal (${oneDecimal(active.goal_hours / 24)} days)`
        : `of ${active.goal_hours}h goal`;
    body = (
      <>
        <div className="ring-wrap">
          <ProgressRing fraction={prog.fraction}>
            <div className="ring-center-value">{formatDurationDays(prog.elapsedMs, true)}</div>
            <div className="ring-center-label">{goalLabel}</div>
          </ProgressRing>
          {stage && (
            <span className="chip" style={{ marginTop: 12 }}>
              {stage.emoji} {stage.title}
            </span>
          )}
          {records.longestMs > 0 && prog.elapsedMs > records.longestMs && (
            <span className="chip chip-accent" style={{ marginTop: 8 }}>
              🏆 Longest fast ever
            </span>
          )}
          {prog.done && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 6,
                marginTop: 14,
              }}
            >
              <span className="chip chip-accent">✓ Goal reached</span>
              <span className="muted small">
                {formatDurationDays(overtimeMs, true)} past your goal — nicely done.
              </span>
            </div>
          )}
          {notifWarn && (
            <span className="chip chip-warn" style={{ marginTop: 12 }}>
              Notifications disabled — countdown hidden
            </span>
          )}
        </div>

        <div className="stat-grid" style={{ margin: "14px 0" }}>
          <div className="stat">
            <div className="stat-value">
              {formatDayStamp(new Date(active.started_at), longSpan)}
            </div>
            <div className="stat-label">Started</div>
          </div>
          <div className="stat">
            <div className="stat-value">{formatDayStamp(end, longSpan)}</div>
            <div className="stat-label">Ends</div>
          </div>
          <div className="stat">
            <div className="stat-value">{formatDurationDays(prog.remainingMs)}</div>
            <div className="stat-label">Remaining</div>
          </div>
          <div className="stat">
            <div className="stat-value">{Math.round(prog.fraction * 100)}%</div>
            <div className="stat-label">Progress</div>
          </div>
        </div>

        {active.purpose && (
          <div className="card" style={{ marginBottom: 14 }}>
            <div className="card-title">Purpose</div>
            <div>{active.purpose}</div>
            <div className="muted small" style={{ marginTop: 4 }}>
              Entries you log during this fast are checked against this.
            </div>
          </div>
        )}

        {manual && (
          <button className="manual-link" onClick={() => go(manualPath(manual.id))}>
            <span>{MANUAL_GLYPH}</span>
            <span style={{ flex: 1 }}>
              Your fasting manual
              <span className="muted small" style={{ display: "block" }}>
                What you&apos;ve worked out with the coach
              </span>
            </span>
            <span className="faint">›</span>
          </button>
        )}

        {flaggedMeal && (
          <div className="card" style={{ marginBottom: 14 }}>
            <div className="card-title">
              🍽️ {fastMeals.length === 1 ? "Meal" : "Meals"} tracked during this fast
            </div>
            {fastMeals.map((m) => (
              <div key={m.id} className="small" style={{ padding: "3px 0" }}>
                <span style={{ fontWeight: 600 }}>{m.title}</span>
                <span className="muted">
                  {" — "}
                  {formatDayStamp(new Date(m.eaten_at), longSpan)}
                  {m.nutrients.calories != null
                    ? ` · ~${Math.round(m.nutrients.calories)} kcal`
                    : ""}
                </span>
                {exempting === m.id ? (
                  <form
                    style={{ marginTop: 6 }}
                    onSubmit={(e) => {
                      e.preventDefault();
                      void handleExempt(m);
                    }}
                  >
                    <input
                      className="input"
                      autoFocus
                      value={exemptNote}
                      onChange={(e) => setExemptNote(e.target.value)}
                      placeholder="Why not? e.g. supplement, negligible calories"
                      aria-label={`Why ${m.title} doesn't break your fast`}
                      maxLength={200}
                    />
                    <div className="btn-row" style={{ marginTop: 6 }}>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        disabled={savingExempt}
                        onClick={() => setExempting(null)}
                      >
                        Cancel
                      </button>
                      <button type="submit" className="btn btn-primary btn-sm" disabled={savingExempt}>
                        {savingExempt ? <span className="spinner" /> : "Save"}
                      </button>
                    </div>
                  </form>
                ) : (
                  <div>
                    <button
                      className="btn btn-ghost btn-sm"
                      style={{ padding: "4px 0", color: "var(--accent)" }}
                      onClick={() => {
                        setExempting(m.id);
                        setExemptNote("");
                      }}
                    >
                      Doesn't break my fast
                    </button>
                  </div>
                )}
              </div>
            ))}
            <div className="muted small" style={{ marginTop: 6 }}>
              If this broke your fast, end it at the meal's time so the record stays
              honest. Something that fits the fast — a supplement, a splash of milk,
              food within what you allowed yourself? Mark it and say why. Backfilling a meal you
              ate before the fast? Give it a time before{" "}
              {formatDayStamp(new Date(active.started_at), longSpan)} and this note
              disappears.
            </div>
            <button
              className="btn btn-danger btn-block"
              style={{ marginTop: 10 }}
              disabled={ending}
              onClick={() => handleEndAtMeal(active, flaggedMeal)}
            >
              End fast at {formatDayStamp(new Date(flaggedMeal.eaten_at), longSpan)}
            </button>
          </div>
        )}

        {error && (
          <div className="error-text" style={{ marginBottom: 10 }}>
            {error}
          </div>
        )}

        {prog.done ? (
          <button
            className="btn btn-primary btn-block"
            disabled={ending}
            onClick={() => handleEnd(active, false)}
          >
            {ending ? <span className="spinner" /> : "Complete fast"}
          </button>
        ) : (
          <button
            className="btn btn-danger btn-block"
            disabled={ending}
            onClick={() => handleEnd(active, true)}
          >
            {ending ? <span className="spinner" /> : "End fast early"}
          </button>
        )}
      </>
    );
  } else {
    body = (
      <div className="card">
        <div className="card-title">Goal</div>
        <div className="seg">
          {PRESET_HOURS.map((h) => (
            <button
              key={h}
              className={`seg-item${!customMode && presetHours === h ? " seg-item-active" : ""}`}
              onClick={() => {
                setCustomMode(false);
                setPresetHours(h);
                setError(null);
              }}
            >
              {h}h
            </button>
          ))}
          <button
            className={`seg-item${customMode ? " seg-item-active" : ""}`}
            onClick={() => {
              setCustomMode(true);
              setError(null);
            }}
          >
            Custom
          </button>
        </div>
        {customMode && (
          <div className="field" style={{ marginTop: 10, marginBottom: 0 }}>
            <label className="label" htmlFor="fast-custom-hours">
              Custom goal (hours)
            </label>
            <input
              id="fast-custom-hours"
              className="input"
              type="number"
              inputMode="decimal"
              min={MIN_HOURS}
              max={MAX_HOURS}
              step={0.5}
              value={customHours}
              onChange={(e) => setCustomHours(e.target.value)}
            />
            {customHours !== "" && !customValid && (
              <div className="error-text" style={{ marginTop: 5 }}>
                Enter between {MIN_HOURS} and {MAX_HOURS} hours.
              </div>
            )}
          </div>
        )}

        <div className="field" style={{ marginTop: 10, marginBottom: 0 }}>
          <label className="label" htmlFor="fast-purpose">
            Purpose (optional)
          </label>
          <input
            id="fast-purpose"
            className="input"
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
            placeholder="e.g. Recoup after the weekend, up to 225 kcal is fine"
            maxLength={300}
          />
          <div className="muted small" style={{ marginTop: 5 }}>
            What it&apos;s for and what you allow yourself. Entries you log during
            the fast are judged by it; leave it empty for a plain fast.
          </div>
        </div>

        {error && (
          <div className="error-text" style={{ marginTop: 10 }}>
            {error}
          </div>
        )}

        <button
          className="btn btn-primary btn-block"
          style={{ marginTop: 12 }}
          disabled={starting || (customMode && !customValid)}
          onClick={handleStart}
        >
          {starting ? <span className="spinner" /> : "Start fasting"}
        </button>

        {lastMealAt && lastMealMs != null && lastMealMs > 0 && (
          <div className="muted small" style={{ marginTop: 10 }}>
            Fasting since: {formatDayStamp(new Date(lastMealAt), lastMealMs > 6 * DAY_MS)}
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      <div
        className="section-title"
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}
      >
        Fasting
        <span className={`chip${active ? " chip-accent" : ""}`}>
          {active ? "Fast in progress" : "Not fasting"}
        </span>
      </div>

      {body}

      <div
        className="section-title"
        style={{ display: "flex", alignItems: "center", gap: 2 }}
      >
        Autophagy &amp; stages
        <InfoButton title="Fasting stages">
          <p>
            These timings are rough estimates from fasting research, much of it
            done in animals.
          </p>
          <p>
            Your last meal, your activity and your own metabolism shift them by
            hours in either direction. Treat the list as a map, not a
            measurement.
          </p>
        </InfoButton>
      </div>
      <StageStrip
        elapsedMs={
          active
            ? fastProgress(active, now).elapsedMs
            : lastMealMs != null && lastMealMs > 0
              ? lastMealMs
              : null
        }
      />

      {records.completed > 0 && (
        <>
          <div className="section-title">Records</div>
          <div className="stat-grid">
            <div className="stat">
              <div className="stat-value">🏆 {formatAchieved(records.longestMs)}</div>
              <div className="stat-label">Longest fast</div>
            </div>
            <div className="stat">
              <div className="stat-value">{Math.round(records.totalHours)}h</div>
              <div className="stat-label">Lifetime fasted</div>
            </div>
            <div className="stat">
              <div className="stat-value">{records.completed}</div>
              <div className="stat-label">Fasts done</div>
            </div>
            <div className="stat">
              <div className="stat-value">{records.goalsHit}</div>
              <div className="stat-label">Goals hit</div>
            </div>
          </div>
        </>
      )}

      <div className="section-title">History</div>
      {history.length === 0 ? (
        <div className="empty">
          <div className="empty-icon">⏳</div>
          No completed fasts yet.
        </div>
      ) : (
        <div className="list">
          {history.map((f) => {
            const achievedMs = f.ended_at
              ? Math.max(0, new Date(f.ended_at).getTime() - new Date(f.started_at).getTime())
              : 0;
            const hitGoal = achievedMs >= f.goal_hours * HOUR_MS - 1000;
            return (
              <div key={f.id} className="list-row">
                <div className="row-main">
                  <div className="row-title">{formatAchieved(achievedMs)} fast</div>
                  <div className="row-sub">
                    {formatStartStamp(f.started_at)}
                    {f.purpose ? ` · ${f.purpose}` : ""}
                  </div>
                </div>
                <div className="row-end">
                  {hitGoal ? (
                    <span className="chip chip-accent">✓ {f.goal_hours}h</span>
                  ) : (
                    <span className="chip">{f.goal_hours}h goal</span>
                  )}
                </div>
                <button
                  className="btn btn-ghost btn-sm"
                  aria-label="Delete fast"
                  onClick={() => handleDelete(f.id)}
                >
                  ✕
                </button>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
