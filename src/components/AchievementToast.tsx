import { useEffect, useState } from "react";
import { ACHIEVEMENTS_BY_KEY, onAchievementsUnlocked } from "../lib/achievements";

/**
 * Announces newly unlocked achievements, whichever page is open — unlocks
 * come from background scans and the capture agent, not just the diary.
 */
export default function AchievementToast() {
  const [text, setText] = useState<string | null>(null);

  useEffect(
    () =>
      onAchievementsUnlocked((keys) => {
        const lastKey = keys[keys.length - 1];
        const def = lastKey ? ACHIEVEMENTS_BY_KEY.get(lastKey) : undefined;
        if (!def) return;
        const extra = keys.length > 1 ? ` (+${keys.length - 1} more)` : "";
        setText(`${def.emoji} Achievement unlocked: ${def.title}${extra}`);
      }),
    [],
  );
  useEffect(() => {
    if (text === null) return;
    const id = window.setTimeout(() => setText(null), 4500);
    return () => window.clearTimeout(id);
  }, [text]);

  if (text === null) return null;
  return (
    <div className="toast" role="status">
      {text}
    </div>
  );
}
