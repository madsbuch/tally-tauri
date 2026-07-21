import { invoke } from "@tauri-apps/api/core";
import {
  cancel,
  isPermissionGranted,
  requestPermission,
  Schedule,
} from "@tauri-apps/plugin-notification";
import type { Fast } from "./types";
import { getActiveFast, getLastMealAt, insertFast, markFastEnded } from "./db";

/** Notification id for the scheduled "fast complete" alert. */
const FAST_DONE_ID = 4218;

function isAndroid(): boolean {
  return navigator.userAgent.includes("Android");
}

/**
 * Schedule the "fast complete" alert. Android only: the desktop plugin
 * ignores `schedule` and would pop the notification immediately.
 *
 * The date is truncated to whole seconds: the Rust layer re-serializes it
 * with 9 fractional digits and the Kotlin side leniently parses them all as
 * milliseconds, so any sub-second part delays the alarm by up to ~11 days.
 */
async function scheduleCompletionAlert(end: Date, goalHours: number): Promise<void> {
  if (!isAndroid()) return;
  const alertAt = new Date(Math.floor(end.getTime() / 1000) * 1000);
  await invoke("plugin:notification|notify", {
    options: {
      id: FAST_DONE_ID,
      title: "Fast complete 🎉",
      body: `You made it ${goalHours} hours. Break your fast gently.`,
      schedule: Schedule.at(alertAt, false, true),
    },
  });
}

export async function ensureNotificationPermission(): Promise<boolean> {
  try {
    if (await isPermissionGranted()) return true;
    return (await requestPermission()) === "granted";
  } catch (e) {
    console.warn("Notification permission check failed", e);
    return false;
  }
}

/** "15:17" for today, "Sat 15:17" otherwise — multi-day fasts need the day. */
function formatEndLabel(end: Date): string {
  const sameDay = end.toDateString() === new Date().toDateString();
  return end.toLocaleString([], {
    ...(sameDay ? {} : { weekday: "short" }),
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** End time of a fast as a Date. */
export function fastEnd(fast: Fast): Date {
  return new Date(new Date(fast.started_at).getTime() + fast.goal_hours * 3_600_000);
}

export interface FastProgress {
  elapsedMs: number;
  remainingMs: number;
  /** 0..1, clamped. */
  fraction: number;
  done: boolean;
}

export function fastProgress(fast: Fast, now = new Date()): FastProgress {
  const start = new Date(fast.started_at).getTime();
  const end = fastEnd(fast).getTime();
  const total = Math.max(1, end - start);
  const elapsedMs = Math.max(0, now.getTime() - start);
  const remainingMs = Math.max(0, end - now.getTime());
  return {
    elapsedMs,
    remainingMs,
    fraction: Math.min(1, elapsedMs / total),
    done: remainingMs <= 0,
  };
}

// ---------------------------------------------------------------------------
// Fasting stages — the metabolic arc of a fast, autophagy included
// ---------------------------------------------------------------------------

export interface FastingStage {
  /** Stage begins at this many hours into the fast. */
  fromH: number;
  /** Stage ends at this many hours (exclusive); null = open-ended final stage. */
  toH: number | null;
  emoji: string;
  title: string;
  blurb: string;
}

/**
 * Approximate stage timings drawn from fasting research (much of it animal
 * studies). The real transitions are gradual and shift by hours with the size
 * of the last meal, activity, and individual metabolism — a map, not a
 * measurement.
 */
export const FASTING_STAGES: FastingStage[] = [
  {
    fromH: 0,
    toH: 4,
    emoji: "🍽️",
    title: "Fed state",
    blurb:
      "Digesting and absorbing the last meal. Insulin is elevated and the body stores the surplus.",
  },
  {
    fromH: 4,
    toH: 12,
    emoji: "📉",
    title: "Early fast",
    blurb:
      "Insulin falls and the liver taps its glycogen store to keep blood sugar steady.",
  },
  {
    fromH: 12,
    toH: 18,
    emoji: "🔥",
    title: "Fat burning",
    blurb:
      "Glycogen runs low, so fat becomes the main fuel and mild ketosis begins.",
  },
  {
    fromH: 18,
    toH: 24,
    emoji: "⚡",
    title: "Ketosis",
    blurb:
      "Ketone levels climb and start fueling the brain. Autophagy — cellular self-cleanup — begins switching on.",
  },
  {
    fromH: 24,
    toH: 48,
    emoji: "♻️",
    title: "Autophagy",
    blurb:
      "Cleanup accelerates: cells recycle damaged proteins and worn-out organelles. Growth hormone rises to protect muscle.",
  },
  {
    fromH: 48,
    toH: 72,
    emoji: "🧹",
    title: "Deep autophagy",
    blurb:
      "Autophagy nears its peak while insulin sensitivity resets and old immune cells are cleared out.",
  },
  {
    fromH: 72,
    toH: null,
    emoji: "🌱",
    title: "Renewal",
    blurb:
      "Stem-cell activity and immune regeneration pick up. Fasts this long need electrolytes and are best done with medical guidance.",
  },
];

/** Index into FASTING_STAGES for a given number of hours fasted. */
export function fastingStageIndex(hours: number): number {
  for (let i = FASTING_STAGES.length - 1; i >= 0; i--) {
    const stage = FASTING_STAGES[i];
    if (stage && hours >= stage.fromH) return i;
  }
  return 0;
}

/** "13:24" style duration formatting (H:MM or H:MM:SS). */
export function formatDuration(ms: number, withSeconds = false): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = String(m).padStart(2, "0");
  if (!withSeconds) return `${h}:${mm}`;
  const ss = String(s).padStart(2, "0");
  return `${h}:${mm}:${ss}`;
}

/** Where a new fast would be anchored. */
export interface FastStart {
  startedAt: Date;
  /** True when the anchor is the last logged meal rather than "now". */
  fromLastMeal: boolean;
}

/**
 * Anchor for a new fast: the last logged meal, so a 24h goal counts time
 * since that meal rather than since the button press. Falls back to "now"
 * when no meal is logged, the meal is in the future (backdated entries), or
 * it is older than the goal — an already-elapsed goal would complete the
 * fast instantly, and a meal that stale likely predates unlogged eating.
 */
export async function resolveFastStart(
  goalHours: number,
  now = new Date(),
): Promise<FastStart> {
  try {
    const lastMeal = await getLastMealAt();
    if (lastMeal) {
      const t = new Date(lastMeal).getTime();
      if (isFinite(t) && t < now.getTime() && now.getTime() - t < goalHours * 3_600_000) {
        return { startedAt: new Date(t), fromLastMeal: true };
      }
    }
  } catch (e) {
    console.warn("Could not look up last meal", e);
  }
  return { startedAt: now, fromLastMeal: false };
}

/**
 * Start a fast: persists it, posts the sticky live-countdown notification
 * (Android), and schedules a completion alert. The fast is anchored to the
 * last logged meal (see resolveFastStart), so elapsed time, the countdown
 * and the completion alert all track time since that meal.
 */
export async function startFast(goalHours: number): Promise<Fast> {
  const active = await getActiveFast();
  if (active) throw new Error("A fast is already running");

  const { startedAt } = await resolveFastStart(goalHours);
  const fast = await insertFast(goalHours, startedAt.toISOString());
  const end = fastEnd(fast);

  const granted = await ensureNotificationPermission();
  if (granted) {
    const endLabel = formatEndLabel(end);
    try {
      await invoke("plugin:fasting|start_countdown", {
        endAtMs: end.getTime(),
        startAtMs: startedAt.getTime(),
        title: `Fasting - ${goalHours}h goal`,
        body: `Ends at ${endLabel}`,
      });
    } catch (e) {
      console.warn("Sticky countdown unavailable", e);
    }
    try {
      await scheduleCompletionAlert(end, goalHours);
    } catch (e) {
      console.warn("Could not schedule completion notification", e);
    }
  }
  return fast;
}

/**
 * End (or cancel) the active fast and clear its notifications. `endedAt`
 * lets the caller end the fast at a specific moment — e.g. at the time of a
 * meal that was tracked mid-fast — rather than "now".
 */
export async function endFast(fast: Fast, endedAt = new Date()): Promise<void> {
  await markFastEnded(fast.id, endedAt.toISOString());
  try {
    await invoke("plugin:fasting|stop_countdown");
  } catch (e) {
    console.warn("Failed to clear sticky countdown", e);
  }
  try {
    await cancel([FAST_DONE_ID]);
  } catch {
    // Desktop or permission-less environments: nothing scheduled to cancel.
  }
}

/**
 * Re-sync the sticky notification with the active fast (call on app start:
 * the notification survives reboots being cleared / app updates).
 */
export async function resyncFastNotification(): Promise<void> {
  const active = await getActiveFast();
  if (!active) {
    try {
      await invoke("plugin:fasting|stop_countdown");
    } catch {
      /* noop */
    }
    return;
  }
  const end = fastEnd(active);
  if (end.getTime() <= Date.now()) return;
  if (!(await ensureNotificationPermission())) return;
  const endLabel = formatEndLabel(end);
  try {
    await invoke("plugin:fasting|start_countdown", {
      endAtMs: end.getTime(),
      startAtMs: new Date(active.started_at).getTime(),
      title: `Fasting - ${active.goal_hours}h goal`,
      body: `Ends at ${endLabel}`,
    });
  } catch {
    /* desktop noop */
  }
  // Re-schedule the completion alert too: Android drops AlarmManager alarms
  // when the app is force-stopped, and the plugin only restores them on boot.
  // Same fixed id → replaces any existing pending alert (idempotent).
  try {
    await cancel([FAST_DONE_ID]);
  } catch {
    /* nothing scheduled */
  }
  try {
    await scheduleCompletionAlert(end, active.goal_hours);
  } catch (e) {
    console.warn("Could not re-schedule completion notification", e);
  }
}
