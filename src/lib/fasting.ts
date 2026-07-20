import { invoke } from "@tauri-apps/api/core";
import {
  cancel,
  isPermissionGranted,
  requestPermission,
  sendNotification,
  Schedule,
} from "@tauri-apps/plugin-notification";
import type { Fast } from "./types";
import { getActiveFast, insertFast, markFastEnded } from "./db";

/** Notification id for the scheduled "fast complete" alert. */
const FAST_DONE_ID = 4218;

export async function ensureNotificationPermission(): Promise<boolean> {
  try {
    if (await isPermissionGranted()) return true;
    return (await requestPermission()) === "granted";
  } catch (e) {
    console.warn("Notification permission check failed", e);
    return false;
  }
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

/**
 * Start a fast: persists it, posts the sticky live-countdown notification
 * (Android), and schedules a completion alert.
 */
export async function startFast(goalHours: number): Promise<Fast> {
  const active = await getActiveFast();
  if (active) throw new Error("A fast is already running");

  const startedAt = new Date();
  const fast = await insertFast(goalHours, startedAt.toISOString());
  const end = fastEnd(fast);

  const granted = await ensureNotificationPermission();
  if (granted) {
    const endLabel = end.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    try {
      await invoke("plugin:fasting|start_countdown", {
        endAtMs: end.getTime(),
        title: `Fasting - ${goalHours}h goal`,
        body: `Ends at ${endLabel}`,
      });
    } catch (e) {
      console.warn("Sticky countdown unavailable", e);
    }
    try {
      sendNotification({
        id: FAST_DONE_ID,
        title: "Fast complete 🎉",
        body: `You made it ${goalHours} hours. Break your fast gently.`,
        schedule: Schedule.at(end, false, true),
      });
    } catch (e) {
      console.warn("Could not schedule completion notification", e);
    }
  }
  return fast;
}

/** End (or cancel) the active fast and clear its notifications. */
export async function endFast(fast: Fast): Promise<void> {
  await markFastEnded(fast.id, new Date().toISOString());
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
  const endLabel = end.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  try {
    await invoke("plugin:fasting|start_countdown", {
      endAtMs: end.getTime(),
      title: `Fasting - ${active.goal_hours}h goal`,
      body: `Ends at ${endLabel}`,
    });
  } catch {
    /* desktop noop */
  }
}
