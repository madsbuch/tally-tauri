import { useEffect, useMemo, useState } from "react";
import {
  ACHIEVEMENTS,
  CATEGORY_LABELS,
  measureFamilies,
  scanAchievements,
} from "../lib/achievements";
import type { AchievementCategory, AchievementDef } from "../lib/achievements";
import { listUnlockedAchievements } from "../lib/db";
import { FREEZE_EARN_DAYS, MAX_FREEZES } from "../lib/streak";
import type { StreakInfo } from "../lib/streak";

const CATEGORY_ORDER: AchievementCategory[] = [
  "logging",
  "capture",
  "fasting",
  "nutrition",
  "training",
  "body",
];

function unlockDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** A standalone achievement, or a tier family shown as one climbing row. */
type Row = { kind: "single"; def: AchievementDef } | { kind: "family"; tiers: AchievementDef[] };

/** Rows of one category, each family placed where its first tier is listed. */
function rowsOf(cat: AchievementCategory): Row[] {
  const rows: Row[] = [];
  const families = new Map<string, AchievementDef[]>();
  for (const def of ACHIEVEMENTS) {
    if (def.category !== cat) continue;
    if (!def.family) {
      rows.push({ kind: "single", def });
      continue;
    }
    const tiers = families.get(def.family);
    if (tiers) tiers.push(def);
    else {
      const fresh = [def];
      families.set(def.family, fresh);
      rows.push({ kind: "family", tiers: fresh });
    }
  }
  return rows;
}

/** 1,234 below ten thousand; 12.3k / 4.5M above, so steps stay readable. */
function formatCount(n: number): string {
  const v = Math.floor(n);
  if (v < 10_000) return v.toLocaleString();
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(v);
}

function AchievementRow({
  def,
  at,
  pips,
  progress,
}: {
  def: AchievementDef;
  /** Unlock timestamp; absent = still locked. */
  at: string | undefined;
  /** Tier pips: how many of how many tiers are unlocked. */
  pips?: { done: number; total: number } | undefined;
  /** Progress toward `def` while it's still the goal. */
  progress?: { value: number; target: number } | undefined;
}) {
  return (
    <div className={`list-row${at ? "" : " ach-locked"}`}>
      <span className="ach-emoji" aria-hidden>
        {at ? def.emoji : "🔒"}
      </span>
      <div className="row-main">
        <div className="row-title">
          {def.title}
          {pips && (
            <span className="ach-pips" aria-label={`Tier ${pips.done} of ${pips.total}`}>
              {Array.from({ length: pips.total }, (_, i) => (
                <span key={i} className={i < pips.done ? "ach-pip ach-pip-on" : "ach-pip"} />
              ))}
            </span>
          )}
        </div>
        <div className="row-sub">{def.description}</div>
        {progress && (
          <div className="ach-progress">
            <div className="ach-bar">
              <div
                className="ach-bar-fill"
                style={{
                  width: `${Math.min(100, (progress.value / progress.target) * 100)}%`,
                }}
              />
            </div>
            <span className="ach-progress-label">
              {formatCount(progress.value)} / {formatCount(progress.target)}
            </span>
          </div>
        )}
      </div>
      {at && (
        <div className="row-end">
          <span className="chip chip-accent">{unlockDate(at)}</span>
        </div>
      )}
    </div>
  );
}

/**
 * Bottom sheet with the streak summary and the full achievement list.
 * Runs a fresh scan on open, so it always reflects the latest data.
 */
export default function AchievementsSheet({
  streak,
  onClose,
  onOpenRecap,
}: {
  streak: StreakInfo | null;
  onClose: () => void;
  onOpenRecap: () => void;
}) {
  const [unlocked, setUnlocked] = useState<Map<string, string> | null>(null);
  const [measured, setMeasured] = useState<Map<string, number>>(new Map());

  useEffect(() => {
    let alive = true;
    scanAchievements()
      .catch(() => [])
      .then(() =>
        Promise.all([listUnlockedAchievements(), measureFamilies().catch(() => new Map())]),
      )
      .then(([m, values]) => {
        if (!alive) return;
        setUnlocked(m);
        setMeasured(values);
      })
      .catch(() => {
        if (alive) setUnlocked(new Map());
      });
    return () => {
      alive = false;
    };
  }, []);

  const grouped = useMemo(() => CATEGORY_ORDER.map((cat) => ({ cat, rows: rowsOf(cat) })), []);
  const unlockedCount = unlocked ? ACHIEVEMENTS.filter((a) => unlocked.has(a.key)).length : 0;

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        <h2 className="sheet-title">🏆 Streak & achievements</h2>

        {streak && (
          <>
            <div className="stat-grid">
              <div className="stat">
                <div className="stat-value">🔥 {streak.current}</div>
                <div className="stat-label">Streak</div>
              </div>
              <div className="stat">
                <div className="stat-value">{streak.best}</div>
                <div className="stat-label">Best</div>
              </div>
              <div className="stat">
                <div className="stat-value">
                  ❄️ {streak.freezes}
                  <span className="faint">/{MAX_FREEZES}</span>
                </div>
                <div className="stat-label">Freezes</div>
              </div>
              <div className="stat">
                <div className="stat-value">{streak.totalDaysLogged}</div>
                <div className="stat-label">Days logged</div>
              </div>
            </div>
            <div className="faint small" style={{ margin: "8px 2px 0" }}>
              A day counts once you log something here — a meal, a workout, a
              supplement, or a running fast. Workouts synced from your watch don't
              count on their own. Every {FREEZE_EARN_DAYS} straight days banks a
              freeze (max {MAX_FREEZES}); a missed day spends one automatically
              instead of breaking the streak.
              {!streak.todayLogged && streak.current > 0 && (
                <> Nothing logged today yet — log something to extend the streak.</>
              )}
            </div>
          </>
        )}

        <button className="btn btn-block" style={{ marginTop: 12 }} onClick={onOpenRecap}>
          📅 Weekly &amp; monthly recaps
        </button>

        <div className="section-title" style={{ display: "flex", justifyContent: "space-between" }}>
          <span>Achievements</span>
          <span className="faint" style={{ textTransform: "none", fontWeight: 500 }}>
            {unlocked ? `${unlockedCount} / ${ACHIEVEMENTS.length}` : ""}
          </span>
        </div>

        {unlocked === null ? (
          <div style={{ display: "flex", justifyContent: "center", padding: 24 }}>
            <span className="spinner" />
          </div>
        ) : (
          grouped.map(({ cat, rows }) => (
            <div key={cat}>
              <div className="ach-cat">{CATEGORY_LABELS[cat]}</div>
              <div className="list">
                {rows.map((row) => {
                  if (row.kind === "single") {
                    const def = row.def;
                    return <AchievementRow key={def.key} def={def} at={unlocked.get(def.key)} />;
                  }
                  // A family shows its highest unlocked tier, or the first one
                  // while none is — and a bar toward the next tier, if any.
                  const { tiers } = row;
                  // By position, not count: tiers share one measure, so a
                  // higher unlock implies the lower ones (a new lower tier
                  // just hasn't been scanned in yet).
                  let done = 0;
                  tiers.forEach((t, i) => {
                    if (unlocked.has(t.key)) done = i + 1;
                  });
                  const top = done > 0 ? tiers[done - 1] : undefined;
                  const next = tiers[done];
                  const value = measured.get(tiers[0]?.family ?? "");
                  const shown = top ?? next;
                  if (!shown) return null;
                  return (
                    <AchievementRow
                      key={shown.key}
                      def={next && top ? { ...top, description: `Next: ${next.description}` } : shown}
                      at={top ? unlocked.get(top.key) : undefined}
                      pips={tiers.length > 1 ? { done, total: tiers.length } : undefined}
                      progress={
                        next?.target != null && value != null
                          ? { value, target: next.target }
                          : undefined
                      }
                    />
                  );
                })}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
