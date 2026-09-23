/**
 * Knowing the coach has said something.
 *
 * A check-in is saved as an ordinary chat, which was the whole problem: the
 * chat list only shows when no conversation is open, and the Coach tab keeps
 * whatever conversation you last had open for as long as Android keeps the
 * process alive. So a check-in could sit there for days, announced by a
 * notification that — tapped — just resumed the app into that stale thread.
 *
 * Both paths that produce a check-in now leave the chat's id in `settings`:
 * the in-app run (lib/coachCheckin.ts) and the Android worker, which writes it
 * with no JavaScript running at all. That single row is what lets the app say
 * "your coach checked in" on the next launch, whatever launched it.
 */
import { useEffect, useState } from "react";
import { getChatSummary, getSetting, setSetting } from "./db";
import { onAppResume } from "./appLifecycle";
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
