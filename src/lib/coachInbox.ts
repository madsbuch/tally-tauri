/**
 * Knowing the coach has said something, and getting to it.
 *
 * A check-in is saved as an ordinary chat, which was the whole problem: the
 * Coach tab keeps whatever conversation you last had open, so a check-in could
 * sit unseen for days, announced by a notification that — tapped — just
 * resumed the app into that stale thread.
 *
 * Two things fix that. The notification carries its chat's id: tapping it
 * hands the id to the app (`takeOpenedCheckin`), which navigates straight to
 * /assistant/:chatId. And both paths that produce a check-in — the in-app run
 * (lib/coachCheckin.ts) and the Android worker, which runs with no JavaScript
 * at all — leave the chat's id in `settings`, so a check-in whose notification
 * was swiped away still shows as unread on the next launch.
 */
import { useEffect, useState } from "react";
import { addPluginListener, invoke } from "@tauri-apps/api/core";
import type { PluginListener } from "@tauri-apps/api/core";
import { getChatSummary, getSetting, setSetting } from "./db";
import { onAppResume, wasSuspendedSince } from "./appLifecycle";
import { SETTING_KEYS } from "./types";

const CHANGED_EVENT = "tally:coach-inbox";

export interface UnreadCheckin {
  id: number;
  title: string;
}

function announce(): void {
  window.dispatchEvent(new CustomEvent(CHANGED_EVENT));
}

/** Point the inbox at a freshly written check-in. */
export async function markCheckinUnread(chatId: number): Promise<void> {
  await setSetting(SETTING_KEYS.coachUnreadChat, String(chatId));
  announce();
}

/**
 * The check-in waiting to be read, if there is one.
 *
 * Clears itself when the chat behind it has been deleted, so a pointer to a
 * chat that no longer exists can't leave a dot on the tab bar forever.
 */
export async function getUnreadCheckin(): Promise<UnreadCheckin | null> {
  const raw = await getSetting(SETTING_KEYS.coachUnreadChat).catch(() => null);
  if (!raw) return null;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return null;
  const chat = await getChatSummary(id).catch(() => null);
  if (!chat) {
    await clearUnreadCheckin();
    return null;
  }
  return { id, title: chat.title };
}

/** Forget the waiting check-in — it's been opened, or it's gone. */
export async function clearUnreadCheckin(): Promise<void> {
  await setSetting(SETTING_KEYS.coachUnreadChat, "").catch(() => {});
  announce();
}

/** Clear it only if `chatId` is the one waiting (opening it counts as reading). */
export async function markCheckinRead(chatId: number): Promise<void> {
  const unread = await getUnreadCheckin();
  if (unread?.id === chatId) await clearUnreadCheckin();
}

/** When `takeOpenedCheckin` last handed a tap out; 0 before the first. */
let lastTakenAt = 0;

/**
 * The check-in whose notification was tapped since this was last asked, if
 * any — each tap is handed out once. Null everywhere but Android, where there
 * are no taps to hand over.
 */
export async function takeOpenedCheckin(): Promise<number | null> {
  try {
    const id = await invoke<number | null>("plugin:coach|take_opened_checkin");
    if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) return null;
    lastTakenAt = Date.now();
    return id;
  } catch {
    return null;
  }
}

/**
 * Whether a tapped check-in has been handed out since the app last came to
 * the foreground — by any caller, since several ask on the way back in.
 */
export function tookCheckinThisVisit(): boolean {
  return lastTakenAt > 0 && !wasSuspendedSince(lastTakenAt);
}

/**
 * Call `fn` when a check-in notification is tapped while the app is running,
 * as it happens — a tap with the app already in front needn't register as a
 * return to the foreground. Returns an unsubscribe function.
 */
export function onCheckinTapped(fn: () => void): () => void {
  let listener: PluginListener | null = null;
  let cancelled = false;
  addPluginListener("coach", "checkinOpened", fn)
    .then((l) => {
      if (cancelled) void l.unregister();
      else listener = l;
    })
    .catch(() => {
      /* not Android: nothing will ever be tapped */
    });
  return () => {
    cancelled = true;
    void listener?.unregister();
  };
}

/**
 * Subscribe to the waiting check-in.
 *
 * Re-reads on every resume as well as on our own events: when the Android
 * worker writes one, the app is closed and has no way to hear about it until
 * it comes back.
 */
export function useUnreadCheckin(): UnreadCheckin | null {
  const [unread, setUnread] = useState<UnreadCheckin | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      void getUnreadCheckin().then((u) => {
        if (alive) setUnread(u);
      });
    };
    load();
    const onChanged = () => load();
    window.addEventListener(CHANGED_EVENT, onChanged);
    const offResume = onAppResume(load);
    return () => {
      alive = false;
      window.removeEventListener(CHANGED_EVENT, onChanged);
      offResume();
    };
  }, []);

  return unread;
}
