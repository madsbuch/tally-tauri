import { useEffect, useMemo, useState } from "react";
import { firstAiUsageDay, listAiUsageSince, todayStr } from "../lib/db";
import { shiftDay } from "../lib/daystamp";
import { useUp } from "../lib/navigation";
import {
  cachedShare,
  featureInfo,
  formatTokens,
  formatUsd,
  groupBy,
  spendOver,
  totalOf,
} from "../lib/aiCost";
import type { UsageGroup, UsageRow } from "../lib/aiCost";
import AssistantChart from "../components/AssistantChart";
import InfoButton from "../components/InfoButton";
import type { ChartSpec } from "../lib/assistant";

type Period = 7 | 30 | 90 | "all";

const PERIODS: { value: Period; label: string }[] = [
  { value: 7, label: "7 days" },
  { value: 30, label: "30 days" },
  { value: 90, label: "90 days" },
  { value: "all", label: "All" },
];

/** The chart holds at most this many bars; longer spans are bucketed. */
const MAX_BARS = 31;

function shortDay(day: string): string {
  const [y = 1970, m = 1, d = 1] = day.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** Days from `a` to `b` inclusive. */
function daysBetween(a: string, b: string): number {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Math.round(ms / 86_400_000) + 1;
}

function requests(n: number): string {
  return `${n.toLocaleString()} request${n === 1 ? "" : "s"}`;
}

function percent(share: number | null): string | null {
  return share == null ? null : `${Math.round(share * 100)}%`;
}

/**
 * Spend over the period as bars. Amounts are shown in cents while the bars
 * stay under a dollar, since the chart rounds to one decimal and most days
 * cost cents.
 */
function spendChart(rows: UsageRow[], first: string, last: string): ChartSpec | null {
  const span = daysBetween(first, last);
  const size = span <= MAX_BARS ? 1 : span <= MAX_BARS * 7 ? 7 : Math.ceil(span / MAX_BARS);
  const buckets = spendOver(rows, first, last, size);
  if (buckets.every((b) => b.costUsd === 0)) return null;
  const cents = Math.max(...buckets.map((b) => b.costUsd)) < 1;
  return {
    type: "bar",
    title: size === 1 ? "Spend per day" : size === 7 ? "Spend per week" : `Spend per ${size} days`,
    unit: cents ? "US cents" : "USD",
    x_labels: buckets.map((b) => shortDay(b.start)),
    series: [
      {
        name: "Spend",
        values: buckets.map((b) => (cents ? b.costUsd * 100 : b.costUsd)),
      },
    ],
  };
}

/** One row of a breakdown, with a bar for its share of the total. */
function GroupRow({
  title,
  sub,
  group,
  total,
}: {
  title: string;
  sub: string;
  group: UsageGroup;
  total: number;
}) {
  const share = total > 0 ? group.costUsd / total : 0;
  return (
    <div style={{ padding: "8px 0", borderTop: "1px solid var(--border)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <div className="row-title" style={{ overflowWrap: "anywhere" }}>
            {title}
          </div>
          <div className="faint small">{sub}</div>
        </div>
        <div style={{ textAlign: "right", flex: "0 0 auto" }}>
          <strong>{formatUsd(group.costUsd)}</strong>
          <div className="faint small">{Math.round(share * 100)}%</div>
        </div>
      </div>
      <div
        style={{
          height: 4,
          borderRadius: 2,
          background: "var(--border)",
          marginTop: 6,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${Math.max(share * 100, share > 0 ? 1 : 0)}%`,
            height: "100%",
            background: "var(--series-1)",
          }}
        />
      </div>
    </div>
  );
}

/**
 * Where the AI money goes: every request to OpenRouter, from the coach to the
 * photo diary, logged with what it was for and what it cost.
 */
export default function CostCenterPage() {
  const up = useUp();
  const [period, setPeriod] = useState<Period>(30);
  const [rows, setRows] = useState<UsageRow[] | null>(null);
  const [firstDay, setFirstDay] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const today = todayStr();

  useEffect(() => {
    let alive = true;
    setRows(null);
    void (async () => {
      try {
        const first = await firstAiUsageDay();
        const since = period === "all" ? (first ?? today) : shiftDay(today, -(period - 1));
        const r = await listAiUsageSince(since);
        if (!alive) return;
        setFirstDay(first);
        setRows(r);
        setError(null);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [period, today]);

  const view = useMemo(() => {
    if (!rows) return null;
    const start =
      period === "all" ? (firstDay ?? today) : shiftDay(today, -(period - 1));
    // Days before anything was logged aren't zero spend, they're unknown;
    // averaging over them would understate the rate.
    const counted = firstDay && firstDay > start ? firstDay : start;
    const total = totalOf(rows);
    return {
      total,
      today: totalOf(rows.filter((r) => r.day === today)),
      perDay: total.costUsd / Math.max(1, daysBetween(counted, today)),
      features: groupBy(rows, "source"),
      models: groupBy(rows, "model"),
      chart: spendChart(rows, counted, today),
    };
  }, [rows, period, firstDay, today]);

  return (
    <div className="page">
      <header className="page-header">
        <h1 className="page-title" style={{ display: "flex", alignItems: "center", gap: 2 }}>
          Cost center
          <InfoButton title="Cost center">
            <p>
              Every request Tally makes to an AI model goes through your
              OpenRouter key: the coach, its check-ins, reading photos and
              estimating meals, documents, entry conversations. Each one is
              logged here with what OpenRouter billed for it.
            </p>
            <p>
              Cached tokens are parts of a request the provider had already
              seen, billed at a fraction of the normal price. A high share
              means long coach conversations are staying cheap.
            </p>
            <p>
              Only requests made since this was added are counted. Your
              OpenRouter dashboard has the full account.
            </p>
          </InfoButton>
        </h1>
        <button className="btn btn-ghost btn-sm" onClick={up}>
          ‹ Settings
        </button>
      </header>

      <div className="seg" style={{ marginBottom: 12 }}>
        {PERIODS.map((p) => (
          <button
            key={p.label}
            className={`seg-item${period === p.value ? " seg-item-active" : ""}`}
            onClick={() => setPeriod(p.value)}
          >
            {p.label}
          </button>
        ))}
      </div>

      {error && <div className="error-text">{error}</div>}

      {!view && !error && (
        <div style={{ display: "flex", justifyContent: "center", padding: 32 }}>
          <span className="spinner" />
        </div>
      )}

      {view && view.total.requests === 0 && (
        <div className="empty">
          <div className="empty-icon">🧾</div>
          {firstDay
            ? "Nothing spent in this period."
            : "Nothing logged yet. What each AI request costs shows up here from now on."}
        </div>
      )}

      {view && view.total.requests > 0 && (
        <>
          <div className="stat-grid" style={{ gridTemplateColumns: "repeat(3, 1fr)", marginBottom: 12 }}>
            <div className="stat">
              <div className="stat-value">{formatUsd(view.total.costUsd)}</div>
              <div className="stat-label">Total</div>
            </div>
            <div className="stat">
              <div className="stat-value">{formatUsd(view.perDay)}</div>
              <div className="stat-label">Per day</div>
            </div>
            <div className="stat">
              <div className="stat-value">{formatUsd(view.today.costUsd)}</div>
              <div className="stat-label">Today</div>
            </div>
          </div>

          <div className="card">
            {view.chart ? (
              <AssistantChart chart={view.chart} />
            ) : (
              <p className="muted small" style={{ margin: 0 }}>
                Too little spent to chart.
              </p>
            )}
            <p className="faint small" style={{ margin: "8px 0 0" }}>
              {requests(view.total.requests)} ·{" "}
              {formatTokens(view.total.promptTokens)} tokens sent
              {percent(cachedShare(view.total))
                ? ` (${percent(cachedShare(view.total))} cached)`
                : ""}{" "}
              · {formatTokens(view.total.completionTokens)} received
            </p>
          </div>

          <div className="card">
            <h2 className="card-title">By feature</h2>
            {view.features.map((g) => {
              const info = featureInfo(g.key);
              return (
                <GroupRow
                  key={g.key}
                  title={info.label}
                  sub={[info.detail, requests(g.requests)]
                    .filter(Boolean)
                    .join(" · ")}
                  group={g}
                  total={view.total.costUsd}
                />
              );
            })}
          </div>

          <div className="card">
            <h2 className="card-title">By model</h2>
            {view.models.map((g) => {
              const cached = percent(cachedShare(g));
              return (
                <GroupRow
                  key={g.key}
                  title={g.key}
                  sub={[
                    requests(g.requests),
                    `${formatUsd(g.requests > 0 ? g.costUsd / g.requests : 0)} each`,
                    cached ? `${cached} cached` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                  group={g}
                  total={view.total.costUsd}
                />
              );
            })}
          </div>

          {firstDay && (
            <p className="faint small" style={{ textAlign: "center" }}>
              As billed by OpenRouter, counted since {shortDay(firstDay)}.
            </p>
          )}
        </>
      )}
    </div>
  );
}
