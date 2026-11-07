/**
 * The Body tab's drawing kit: hourly curves, store bars, banded gauges and
 * the small pickers inside info sheets. Shared by BodyPage and BodyStores.
 */
import { useEffect, useRef, useState } from "react";
import { STORE_SHOWN_DAYS } from "../lib/body";
import type { HourlyLevel } from "../lib/body";
import { shiftDay } from "../lib/daystamp";
import { todayStr } from "../lib/db";
import type { Band } from "../lib/storeModels";

/** A number that glides to its new value instead of jumping. */
export function useGlide(target: number, ms = 700): number {
  const [shown, setShown] = useState(0);
  const from = useRef(0);
  useEffect(() => {
    const start = performance.now();
    const origin = from.current;
    let frame = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / ms);
      const eased = 1 - Math.pow(1 - p, 3);
      const v = origin + (target - origin) * eased;
      from.current = v;
      setShown(v);
      if (p < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, ms]);
  return shown;
}

export function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** "22:10", or "tomorrow 01:30" when it's past midnight. */
export function clockDay(ms: number, now: number): string {
  const day = todayStr(new Date(ms));
  const today = todayStr(new Date(now));
  if (day === today) return clock(ms);
  if (day === shiftDay(today, 1)) return `tomorrow ${clock(ms)}`;
  return new Date(ms).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

/** "Thu 12 Nov" for a local "YYYY-MM-DD". */
export function dayLabel(day: string): string {
  const [y = 0, m = 1, d = 1] = day.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString([], {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

const VB_W = 300;
const VB_H = 100;

/**
 * The curve: solid up to now, a fainter dashed forecast after. It draws in
 * from the left on first show, and the now-dot breathes — the level is
 * changing while you look at it.
 */
export function LevelCurve({
  level,
  now,
  color,
  threshold,
  thresholdLabel,
  glyph,
  minScale,
  marks = [],
}: {
  level: HourlyLevel;
  now: number;
  color: string;
  threshold?: number;
  thresholdLabel?: string;
  glyph: string;
  minScale: number;
  /** Other moments to flag on the curve (a meter reading), with their own glyph. */
  marks?: { at: number; glyph: string; title: string }[];
}) {
  const { series, from, to, doses } = level;
  const peak = Math.max(minScale, threshold != null ? threshold * 1.6 : 0, ...series.map((p) => p.amount));
  const yMax = peak * 1.12;
  const x = (t: number) => ((t - from) / (to - from)) * VB_W;
  const y = (v: number) => VB_H - (v / yMax) * VB_H;

  const past = series.filter((p) => p.t <= now);
  const future = series.filter((p) => p.t >= now);
  const line = (pts: typeof series) =>
    pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.t).toFixed(1)},${y(p.amount).toFixed(1)}`).join("");
  const area = (pts: typeof series) => {
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (!first || !last) return "";
    return `${line(pts)}L${x(last.t).toFixed(1)},${VB_H}L${x(first.t).toFixed(1)},${VB_H}Z`;
  };
  const nowPoint = past[past.length - 1];
  const nowX = (x(now) / VB_W) * 100;
  const nowY = nowPoint ? (y(nowPoint.amount) / VB_H) * 100 : 100;

  return (
    <div className="level-chart" style={{ ["--level" as string]: color }}>
      <div className="level-plot">
        <svg viewBox={`0 0 ${VB_W} ${VB_H}`} preserveAspectRatio="none" aria-hidden>
          {threshold != null && (
            <line
              x1={0}
              x2={VB_W}
              y1={y(threshold)}
              y2={y(threshold)}
              className="level-threshold"
              vectorEffect="non-scaling-stroke"
            />
          )}
          <g className="level-reveal">
            <path d={area(future)} className="level-area-future" />
            <path d={line(future)} className="level-line-future" vectorEffect="non-scaling-stroke" />
            <path d={area(past)} className="level-area" />
            <path d={line(past)} className="level-line" vectorEffect="non-scaling-stroke" />
          </g>
          <line
            x1={x(now)}
            x2={x(now)}
            y1={0}
            y2={VB_H}
            className="level-now-line"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        {threshold != null && thresholdLabel && (
          <span
            className="level-threshold-label"
            style={{ top: `calc(${(y(threshold) / VB_H) * 100}% - 15px)` }}
          >
            {thresholdLabel}
          </span>
        )}
        <span className="level-dot" style={{ left: `${nowX}%`, top: `${nowY}%` }} />
        {doses.map((d) => (
          <span
            key={d.at}
            className="level-dose"
            style={{ left: `${(x(d.at) / VB_W) * 100}%` }}
            title={`${clock(d.at)}`}
          >
            {glyph}
          </span>
        ))}
        {marks.map((mk) => (
          <span
            key={`m${mk.at}`}
            className="level-dose"
            style={{ left: `${(x(mk.at) / VB_W) * 100}%` }}
            title={mk.title}
          >
            {mk.glyph}
          </span>
        ))}
      </div>
      <div className="level-ticks">
        {hourTicks(from, to, now).map((t) => (
          <span key={t} style={{ left: `${(x(t) / VB_W) * 100}%` }}>
            {new Date(t).getHours() === 0 ? "midnight" : clock(t)}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * Every six hours on the clock (00, 06, 12, 18) inside the window — a fixed
 * grid reads faster than "8 h ago" — or every twelve on a chart longer than
 * a day and a bit (glycogen's two days), leaving out any that would crowd
 * "now" (the line itself) or the chart's edges.
 */
export function hourTicks(from: number, to: number, now: number): number[] {
  const out: number[] = [];
  const step = to - from > 30 * 3_600_000 ? 12 : 6;
  const d = new Date(from);
  d.setMinutes(0, 0, 0);
  d.setHours(Math.ceil(d.getHours() / step) * step);
  const margin = (to - from) * 0.06;
  for (let t = d.getTime(); t <= to; t += step * 3_600_000) {
    if (t - from < margin || to - t < margin || Math.abs(t - now) < margin) continue;
    out.push(t);
  }
  return out;
}

/** A store that fills over weeks: a tank bar, and its last two months. */
export function StoreBar({
  fraction,
  series,
  color,
  threshold,
  thresholdLabel,
  scaleMax,
  since = `${STORE_SHOWN_DAYS} days ago`,
}: {
  fraction: number;
  series: number[];
  color: string;
  /** A line across bar and history, as a fraction of `scaleMax`. */
  threshold?: number;
  thresholdLabel?: string;
  /** Top of the history's scale; defaults to its own peak. */
  scaleMax?: number;
  /** Left end of the history's axis. */
  since?: string;
}) {
  // Starts empty and fills to where it is, so the eye reads it as a level.
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(fraction));
    return () => cancelAnimationFrame(id);
  }, [fraction]);
  const peak = Math.max(...series, 0);
  const max = scaleMax ?? Math.max(1e-9, peak);
  const yOf = (v: number) => 30 - (v / max) * 28;
  const pts = series
    .map((v, i) => `${((i / Math.max(1, series.length - 1)) * 100).toFixed(1)},${yOf(v).toFixed(1)}`)
    .join(" ");
  return (
    <div style={{ ["--level" as string]: color }}>
      <div className="tank-wrap">
        <div className="tank">
          <div className="tank-fill" style={{ width: `${Math.min(1, Math.max(0, shown)) * 100}%` }} />
        </div>
        {threshold != null && (
          <span className="tank-mark" style={{ left: `${threshold * 100}%` }}>
            {thresholdLabel && <span className="tank-mark-label">{thresholdLabel}</span>}
          </span>
        )}
      </div>
      {peak > 1e-6 && (
        <svg className="store-spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden>
          {threshold != null && (
            <line
              x1={0}
              x2={100}
              y1={yOf(threshold * max)}
              y2={yOf(threshold * max)}
              className="level-threshold"
              vectorEffect="non-scaling-stroke"
            />
          )}
          <polyline points={pts} vectorEffect="non-scaling-stroke" />
        </svg>
      )}
      <div className="level-axis">
        <span>{since}</span>
        <span>today</span>
      </div>
    </div>
  );
}

/** How a band reads, as a colour. */
export const TONE_COLOR: Record<Band["tone"], string> = {
  bad: "var(--danger)",
  warn: "var(--warn)",
  ok: "var(--vitd)",
  good: "var(--accent)",
};

/**
 * A level on a fixed scale with its bands tinted behind it — vitamin D in
 * nmol/L, ferritin in µg/L — ticks at the cut-offs, and the last two months
 * underneath with lines at the ones that matter most.
 */
export function BandGauge({
  value,
  scaleMax,
  bands,
  ticks,
  lines = [],
  series,
  band,
  since,
  format = (n) => String(n),
}: {
  value: number;
  scaleMax: number;
  bands: readonly Band[];
  /** Values to tick on the bar. */
  ticks: number[];
  /** Values to draw across the history. */
  lines?: number[];
  series: number[];
  /** The band `value` is in: colours the fill. */
  band: Band;
  since?: string;
  format?: (n: number) => string;
}) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(value));
    return () => cancelAnimationFrame(id);
  }, [value]);
  const pct = (n: number) => `${(Math.min(scaleMax, Math.max(0, n)) / scaleMax) * 100}%`;
  const yOf = (n: number) => 30 - (Math.min(scaleMax, Math.max(0, n)) / scaleMax) * 28;
  const pts = series
    .map((n, i) => `${((i / Math.max(1, series.length - 1)) * 100).toFixed(1)},${yOf(n).toFixed(1)}`)
    .join(" ");
  let from = 0;
  const segs = bands
    .map((b) => {
      const seg = { key: b.key, tone: b.tone, from, to: Math.min(scaleMax, b.upTo) };
      from = seg.to;
      return seg;
    })
    .filter((b) => b.to > b.from);
  return (
    <div style={{ ["--level" as string]: TONE_COLOR[band.tone] }}>
      <div className="tank-wrap">
        <div className="tank band-tank">
          {segs.map((b) => (
            <div
              key={b.key}
              className={`band-seg band-seg-${b.tone}`}
              style={{ left: pct(b.from), width: `calc(${pct(b.to)} - ${pct(b.from)})` }}
            />
          ))}
          <div className="tank-fill" style={{ width: pct(shown) }} />
        </div>
        {ticks.map((n) => (
          <span key={n} className="tank-mark" style={{ left: pct(n) }}>
            <span className="tank-mark-label">{format(n)}</span>
          </span>
        ))}
      </div>
      {series.length > 1 && (
        <svg className="store-spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden>
          {lines.map((n) => (
            <line
              key={n}
              x1={0}
              x2={100}
              y1={yOf(n)}
              y2={yOf(n)}
              className="level-threshold"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          <polyline points={pts} vectorEffect="non-scaling-stroke" />
        </svg>
      )}
      <div className="level-axis">
        <span>{since ?? `${STORE_SHOWN_DAYS} days ago`}</span>
        <span>today</span>
      </div>
    </div>
  );
}

/** Several histories on one small chart, each its own colour (fitness vs fatigue). */
export function MultiSpark({
  lines,
  since,
}: {
  lines: { values: number[]; color: string; label: string; dashed?: boolean }[];
  since: string;
}) {
  const max = Math.max(1e-6, ...lines.flatMap((l) => l.values));
  const yOf = (v: number) => 40 - (v / max) * 37;
  return (
    <div>
      <svg className="store-spark multi-spark" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden>
        {lines.map((l) => (
          <polyline
            key={l.label}
            points={l.values
              .map((v, i) => `${((i / Math.max(1, l.values.length - 1)) * 100).toFixed(1)},${yOf(v).toFixed(1)}`)
              .join(" ")}
            style={{ stroke: l.color, strokeDasharray: l.dashed ? "3 3" : undefined }}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      <div className="level-axis">
        <span>{since}</span>
        <span className="multi-spark-legend">
          {lines.map((l) => (
            <span key={l.label}>
              <i style={{ background: l.color }} /> {l.label}
            </span>
          ))}
        </span>
        <span>today</span>
      </div>
    </div>
  );
}

/** A row of choices, as in the caffeine half-life picker. */
export function SegPicker<T extends number>({
  options,
  value,
  onChange,
  format,
}: {
  options: readonly T[];
  value: number;
  onChange: (v: T) => void;
  format: (v: T) => string;
}) {
  return (
    <div className="seg" style={{ marginTop: 8 }}>
      {options.map((o) => (
        <button
          key={o}
          className={`seg-item${value === o ? " seg-item-active" : ""}`}
          onClick={() => onChange(o)}
        >
          {format(o)}
        </button>
      ))}
    </div>
  );
}
