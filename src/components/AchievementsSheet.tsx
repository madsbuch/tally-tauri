import { useEffect, useMemo, useState } from "react";
import {
  ACHIEVEMENTS,
  CATEGORY_LABELS,
  scanAchievements,
} from "../lib/achievements";
import type { AchievementCategory } from "../lib/achievements";
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

/**
 * Bottom sheet with the streak summary and the full achievement list.
 * Runs a fresh scan on open, so it always reflects the latest data.
 */
export default function AchievementsSheet({
  streak,
  onClose,
}: {
  streak: StreakInfo | null;
  onClose: () => void;
}) {
  const [unlocked, setUnlocked] = useState<Map<string, string> | null>(null);

  useEffect(() => {
    let alive = true;
    scanAchievements()
      .catch(() => [])
      .then(() => listUnlockedAchievements())
      .then((m) => {
        if (alive) setUnlocked(m);
      })
      .catch(() => {
        if (alive) setUnlocked(new Map());
      });
    return () => {
      alive = false;
    };
  }, []);

  const grouped = useMemo(
    () =>
      CATEGORY_ORDER.map((cat) => ({
        cat,
        defs: ACHIEVEMENTS.filter((a) => a.category === cat),
      })),
    [],
  );
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
              A day counts once anything is logged — meals, workouts, supplements, or a
              running fast. Every {FREEZE_EARN_DAYS} straight days banks a freeze
              (max {MAX_FREEZES}); a missed day spends one automatically instead of
              breaking the streak.
              {!streak.todayLogged && streak.current > 0 && (
                <> Nothing logged today yet — log something to extend the streak.</>
              )}
            </div>
          </>
        )}

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
          grouped.map(({ cat, defs }) => (
            <div key={cat}>
              <div className="ach-cat">{CATEGORY_LABELS[cat]}</div>
              <div className="list">
                {defs.map((a) => {
                  const at = unlocked.get(a.key);
                  return (
                    <div key={a.key} className={`list-row${at ? "" : " ach-locked"}`}>
                      <span className="ach-emoji" aria-hidden>
                        {at ? a.emoji : "🔒"}
                      </span>
                      <div className="row-main">
                        <div className="row-title">{a.title}</div>
                        <div className="row-sub">{a.description}</div>
                      </div>
                      {at && (
                        <div className="row-end">
                          <span className="chip chip-accent">{unlockDate(at)}</span>
                        </div>
                      )}
                    </div>
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
