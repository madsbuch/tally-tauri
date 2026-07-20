import type { ChartSpec } from "../lib/assistant";

/**
 * Small static SVG chart for assistant chat bubbles (bar or line, ≤3 series).
 * Series colors are a fixed-order categorical set validated for CVD safety on
 * the white card surface (green → blue → amber, never re-ordered).
 */
const SERIES_COLORS = ["#2f7a4d", "#3f7fc1", "#b06e2a"];

const W = 340;
const PLOT_H = 150;
const M = { top: 8, right: 10, bottom: 20, left: 40 };

function fmt(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 10_000) return `${(v / 1000).toFixed(abs >= 100_000 ? 0 : 1)}k`;
  if (abs >= 100 || Number.isInteger(v)) return Math.round(v).toLocaleString();
  return v.toFixed(1);
}

/** ~3 rounded tick values covering [min, max]. */
function ticks(min: number, max: number): number[] {
  if (max === min) max = min + 1;
  const span = max - min;
  const step0 = span / 3;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) ?? step0;
  const start = Math.ceil(min / step) * step;
  const out: number[] = [];
  for (let v = start; v <= max + 1e-9; v += step) out.push(v);
  return out;
}

/** Indices of at most `n` x labels, always including first and last. */
function sampleIndices(count: number, n = 6): number[] {
  if (count <= n) return Array.from({ length: count }, (_, i) => i);
  const out = new Set<number>();
  for (let i = 0; i < n; i++) out.add(Math.round((i * (count - 1)) / (n - 1)));
  return [...out].sort((a, b) => a - b);
}

export default function AssistantChart({ chart }: { chart: ChartSpec }) {
  const { x_labels, series, type } = chart;
  const values = series.flatMap((s) => s.values).filter((v): v is number => v != null);
  if (values.length === 0) return null;

  const showBarLabels = type === "bar" && x_labels.length * series.length <= 8;

  let lo = Math.min(...values);
  let hi = Math.max(...values);
  // Bars compare magnitude — anchor them at zero. Lines may zoom in.
  if (type === "bar") lo = Math.min(0, lo);
  if (hi === lo) hi = lo + 1;
  // Headroom so line padding / bar value labels never clip at the plot top.
  const pad = (hi - lo) * (showBarLabels ? 0.12 : type === "line" ? 0.08 : 0.02);
  const yLo = type === "bar" ? lo : lo - pad;
  const yHi = hi + pad;

  const plotW = W - M.left - M.right;
  const y = (v: number) => M.top + PLOT_H - ((v - yLo) / (yHi - yLo)) * PLOT_H;
  const slotW = plotW / x_labels.length;
  const xCenter = (i: number) => M.left + slotW * (i + 0.5);

  const yTicks = ticks(yLo, yHi);
  const xIdx = sampleIndices(x_labels.length);

  // Grouped bars: 2px gap between neighbours, anchored to the baseline.
  const barGap = 2;
  const groupW = Math.min(slotW - 6, series.length * 26);
  const barW = Math.max(3, (groupW - barGap * (series.length - 1)) / series.length);
  const baseline = y(Math.max(yLo, 0));

  // Lines: nulls split a series into separate polyline segments.
  function lineSegments(vals: (number | null)[]): string[] {
    const segs: string[] = [];
    let cur: string[] = [];
    vals.forEach((v, i) => {
      if (v == null) {
        if (cur.length > 1) segs.push(cur.join(" "));
        cur = [];
      } else {
        cur.push(`${xCenter(i)},${y(v)}`);
      }
    });
    if (cur.length > 1) segs.push(cur.join(" "));
    return segs;
  }

  function lastPoint(vals: (number | null)[]): { i: number; v: number } | null {
    for (let i = vals.length - 1; i >= 0; i--) {
      const v = vals[i];
      if (v != null) return { i, v };
    }
    return null;
  }

  return (
    <div className="chart">
      <div className="chart-head">
        <span className="chart-title">{chart.title}</span>
        {chart.unit && <span className="chart-unit">{chart.unit}</span>}
      </div>
      {series.length > 1 && (
        <div className="chart-legend">
          {series.map((s, si) => (
            <span key={si} className="chart-legend-item">
              <span className="chart-dot" style={{ background: SERIES_COLORS[si] }} />
              {s.name}
            </span>
          ))}
        </div>
      )}
      <svg
        viewBox={`0 0 ${W} ${M.top + PLOT_H + M.bottom}`}
        style={{ width: "100%", height: "auto", display: "block" }}
        role="img"
        aria-label={chart.title}
      >
        {yTicks.map((t, i) => (
          <g key={i}>
            <line
              x1={M.left}
              x2={W - M.right}
              y1={y(t)}
              y2={y(t)}
              stroke="var(--border)"
              strokeWidth={1}
              opacity={0.6}
            />
            <text
              x={M.left - 5}
              y={y(t) + 3}
              textAnchor="end"
              fontSize={9.5}
              fill="var(--faint)"
            >
              {fmt(t)}
            </text>
          </g>
        ))}

        {type === "bar" &&
          series.map((s, si) =>
            s.values.map((v, i) => {
              if (v == null) return null;
              const x0 = xCenter(i) - groupW / 2 + si * (barW + barGap);
              const top = Math.min(y(v), baseline);
              const h = Math.max(1.5, Math.abs(baseline - y(v)));
              return (
                <g key={`${si}-${i}`}>
                  <rect
                    x={x0}
                    y={top}
                    width={barW}
                    height={h}
                    rx={2}
                    fill={SERIES_COLORS[si]}
                  />
                  {showBarLabels && (
                    <text
                      x={x0 + barW / 2}
                      y={top - 4}
                      textAnchor="middle"
                      fontSize={9.5}
                      fill="var(--muted)"
                    >
                      {fmt(v)}
                    </text>
                  )}
                </g>
              );
            }),
          )}

        {type === "line" &&
          series.map((s, si) => (
            <g key={si}>
              {lineSegments(s.values).map((pts, j) => (
                <polyline
                  key={j}
                  points={pts}
                  fill="none"
                  stroke={SERIES_COLORS[si]}
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              ))}
              {s.values.map((v, i) =>
                v != null &&
                (s.values[i - 1] == null || s.values[i + 1] == null) ? (
                  // Mark isolated/endpoint samples so single points stay visible.
                  <circle key={i} cx={xCenter(i)} cy={y(v)} r={2.5} fill={SERIES_COLORS[si]} />
                ) : null,
              )}
              {(() => {
                const lp = lastPoint(s.values);
                if (!lp) return null;
                return (
                  <text
                    x={Math.min(xCenter(lp.i) + 5, W - M.right)}
                    y={y(lp.v) - 5}
                    textAnchor="end"
                    fontSize={9.5}
                    fontWeight={650}
                    fill="var(--muted)"
                  >
                    {fmt(lp.v)}
                  </text>
                );
              })()}
            </g>
          ))}

        {xIdx.map((i) => (
          <text
            key={i}
            x={xCenter(i)}
            y={M.top + PLOT_H + 14}
            textAnchor={i === 0 ? "start" : i === x_labels.length - 1 ? "end" : "middle"}
            fontSize={9.5}
            fill="var(--faint)"
          >
            {x_labels[i]}
          </text>
        ))}
      </svg>
    </div>
  );
}
