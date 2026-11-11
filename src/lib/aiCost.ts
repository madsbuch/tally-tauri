/**
 * The cost center's vocabulary and arithmetic: what each AI feature is
 * called, and how the `ai_usage` ledger rolls up into totals, a breakdown by
 * feature and by model, and spend over time.
 *
 * Every request to OpenRouter is logged under the feature that made it (see
 * `logUsage` in lib/openrouter.ts); the Android check-in worker logs its own
 * as "checkin". Pure, so the roll-ups can be tested without a database.
 */

export const AI_FEATURES = [
  "coach",
  "checkin",
  "diary",
  "entry_chat",
  "document",
  "supplement",
  "state_icon",
  "photo",
  "test",
] as const;

export type AiFeature = (typeof AI_FEATURES)[number];

const FEATURE_INFO: Record<AiFeature, { label: string; detail: string }> = {
  coach: { label: "Coach chats", detail: "Conversations with the coach" },
  checkin: { label: "Coach check-ins", detail: "Messages the coach sent unasked" },
  diary: {
    label: "Photo & food estimates",
    detail: "Reading captures and estimating meals and workouts",
  },
  entry_chat: { label: "Entry conversations", detail: "Questions and corrections on one entry" },
  document: { label: "Documents", detail: "Reading lab results and reports" },
  supplement: { label: "Supplements", detail: "Nutrients from a supplement label" },
  state_icon: { label: "State icons", detail: "Picking an emoji for a new state" },
  photo: { label: "Photo analysis", detail: "One-shot photo reading" },
  test: { label: "Connection tests", detail: "Testing the API key in Settings" },
};

/** Display name and one-line description; unknown sources show as logged. */
export function featureInfo(source: string): { label: string; detail: string } {
  return (FEATURE_INFO as Record<string, { label: string; detail: string }>)[source] ?? {
    label: source,
    detail: "",
  };
}

/** One row of the ledger, summed per day, feature and model. */
export interface UsageRow {
  day: string;
  source: string;
  model: string;
  requests: number;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  costUsd: number;
}

export interface UsageTotals {
  requests: number;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  costUsd: number;
}

export interface UsageGroup extends UsageTotals {
  key: string;
}

function emptyTotals(): UsageTotals {
  return { requests: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0, costUsd: 0 };
}

function add(into: UsageTotals, r: UsageTotals): void {
  into.requests += r.requests;
  into.promptTokens += r.promptTokens;
  into.cachedTokens += r.cachedTokens;
  into.completionTokens += r.completionTokens;
  into.costUsd += r.costUsd;
}

export function totalOf(rows: UsageRow[]): UsageTotals {
  const t = emptyTotals();
  for (const r of rows) add(t, r);
  return t;
}

/** Sum by `source` or `model`, most expensive first. */
export function groupBy(rows: UsageRow[], key: "source" | "model"): UsageGroup[] {
  const groups = new Map<string, UsageGroup>();
  for (const r of rows) {
    const k = r[key];
    let g = groups.get(k);
    if (!g) {
      g = { key: k, ...emptyTotals() };
      groups.set(k, g);
    }
    add(g, r);
  }
  return [...groups.values()].sort((a, b) => b.costUsd - a.costUsd || b.requests - a.requests);
}

/** Share of prompt tokens read from the cache, 0–1; null when nothing was sent. */
export function cachedShare(t: UsageTotals): number | null {
  return t.promptTokens > 0 ? t.cachedTokens / t.promptTokens : null;
}

/** Shift a "YYYY-MM-DD" day by whole days. */
function shift(day: string, delta: number): string {
  const [y = 1970, m = 1, d = 1] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  return dt.toISOString().slice(0, 10);
}

export interface SpendBucket {
  /** First day of the bucket. */
  start: string;
  costUsd: number;
}

/**
 * Spend per bucket of `size` days, from `first` through `last` inclusive,
 * with empty days as zero so the gaps show. The last bucket ends on `last`.
 */
export function spendOver(
  rows: UsageRow[],
  first: string,
  last: string,
  size: number,
): SpendBucket[] {
  const byDay = new Map<string, number>();
  for (const r of rows) byDay.set(r.day, (byDay.get(r.day) ?? 0) + r.costUsd);
  const buckets: SpendBucket[] = [];
  // Built backwards from `last`, so the newest bucket is always whole.
  for (let end = last; end >= first; end = shift(end, -size)) {
    let start = shift(end, -(size - 1));
    if (start < first) start = first;
    let cost = 0;
    for (let d = start; d <= end; d = shift(d, 1)) cost += byDay.get(d) ?? 0;
    buckets.push({ start, costUsd: cost });
  }
  return buckets.reverse();
}

/** "$0.42", or "<$0.01" for the small amounts most requests cost. */
export function formatUsd(usd: number): string {
  if (usd <= 0) return "$0.00";
  if (usd < 0.01) return "<$0.01";
  if (usd >= 100) return `$${Math.round(usd)}`;
  return `$${usd.toFixed(2)}`;
}

/** "1.2M", "34k", "512": token counts at a glance. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}
