import { useCallback, useEffect, useState } from "react";
import type { Fast } from "../lib/types";
import { DEFAULT_FAST_HOURS, SETTING_KEYS } from "../lib/types";
import {
  deleteFast,
  getActiveFast,
  getSetting,
  listRecentFasts,
  setSetting,
} from "../lib/db";
import {
  endFast,
  ensureNotificationPermission,
  fastEnd,
  fastProgress,
  formatDuration,
  startFast,
} from "../lib/fasting";

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

export default function FastingPage() {
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState<Fast | null>(null);
  const [history, setHistory] = useState<Fast[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notifWarn, setNotifWarn] = useState(false);

  const [presetHours, setPresetHours] = useState<number>(DEFAULT_FAST_HOURS);
  const [customMode, setCustomMode] = useState(false);
  const [customHours, setCustomHours] = useState(String(DEFAULT_FAST_HOURS));

  const [starting, setStarting] = useState(false);
  const [ending, setEnding] = useState(false);
  const [now, setNow] = useState(() => new Date());

  const loadHistory = useCallback(async () => {
    setHistory(await listRecentFasts(30));
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [fast, fasts, saved] = await Promise.all([
          getActiveFast(),
          listRecentFasts(30),
          getSetting(SETTING_KEYS.fastDefaultHours),
        ]);
        if (cancelled) return;
        setActive(fast);
        setHistory(fasts);
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

  // 1s ticker while a fast is active.
  useEffect(() => {
    if (!active) return;
    setNow(new Date());
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, [active]);

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
      const fast = await startFast(chosenHours);
      setActive(fast);
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

  async function handleEnd(fast: Fast, early: boolean) {
    if (
      early &&
      !window.confirm("End this fast before reaching your goal? It will be saved to history.")
    ) {
      return;
    }
    setError(null);
    setEnding(true);
    try {
      await endFast(fast);
      setActive(null);
      setNotifWarn(false);
      await loadHistory();
    } catch {
      setError("Could not end the fast.");
    } finally {
      setEnding(false);
    }
  }

  async function handleDelete(id: number) {
    if (!window.confirm("Delete this fast from history?")) return;
    setError(null);
    try {
      await deleteFast(id);
      setHistory((prev) => prev.filter((f) => f.id !== id));
    } catch {
      setError("Could not delete the fast.");
    }
  }

  if (loading) {
    return (
      <div className="page">
        <header className="page-header">
          <h1 className="page-title">Fasting</h1>
        </header>
        <div className="empty" style={{ display: "flex", justifyContent: "center" }}>
          <span className="spinner" />
        </div>
      </div>
    );
  }

  let body: React.ReactNode;
  if (active) {
    const prog = fastProgress(active, now);
    const end = fastEnd(active);
    const overtimeMs = Math.max(0, prog.elapsedMs - active.goal_hours * HOUR_MS);
    const longSpan = active.goal_hours > 6 * 24;
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

        <div className="muted small" style={{ marginTop: 10 }}>
          While fasting, a pinned notification shows the live time remaining — even when the
          app is closed.
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1 className="page-title">Fasting</h1>
        <span className="page-sub">{active ? "Fast in progress" : "Not fasting"}</span>
      </header>

      {body}

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
                  <div className="row-sub">{formatStartStamp(f.started_at)}</div>
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
    </div>
  );
}
