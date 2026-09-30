/**
 * Where every screen lives, and the one way of getting to it.
 *
 * What's on screen is the URL's to say — which tab, which entry, which
 * conversation — so anything that wants to show you something (the tab bar, a
 * banner, the recap sheet, a notification tapped with the app closed) asks for
 * an address and gets there the same way.
 *
 * The app is two levels deep: five tabs, and pages that belong to one of them
 * (an entry to the Diary; a conversation and the library to the Coach). The
 * history always has one shape — the tab, at most one of its pages, then any
 * open sheets — so back from a page lands on its tab and back from a tab
 * leaves the app, however you got there. `go` keeps it that shape:
 *
 * - into a page from its own tab: push, so back returns to the tab;
 * - from one page of a tab to another: replace, so back still does;
 * - anywhere else: unwind to the first entry, put the target's tab there, and
 *   push the page on top if there is one. A tab switch and a deep link are the
 *   same move — a conversation opened from a notification has the Coach tab
 *   beneath it, exactly as if you'd opened it by hand.
 */
import { useCallback } from "react";
import { generatePath, useNavigate } from "react-router-dom";
import type { Path } from "../router";
import { closeSheets, pageIndex, unwindHistory } from "./sheetHistory";

/** The tab bar's destinations. */
export const TAB_ROOTS = [
  "/",
  "/nutrients",
  "/fasting",
  "/assistant",
  "/settings",
] as const satisfies readonly Path[];

export type TabRoot = (typeof TAB_ROOTS)[number];

/**
 * The tab a path belongs to: its first segment, since every page lives under
 * its tab — except the Diary's entries, the Diary being "/". Anything unknown
 * is the Diary's too, which is where the 404 route sends it.
 */
export function tabOf(path: string): TabRoot {
  const root = `/${path.split("/")[1] ?? ""}`;
  return TAB_ROOTS.find((t) => t === root) ?? "/";
}

const CHAT_ROUTE = "/assistant/:chatId" satisfies Path;

/** A coach conversation's address. */
export function chatPath(chatId: number): string {
  return generatePath(CHAT_ROUTE, { chatId: String(chatId) });
}

/** The chat id in a `:chatId` param, or null when it isn't one. */
export function parseChatId(raw: string | undefined): number | null {
  if (!raw || !/^[1-9]\d*$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

/** The conversation a path shows, or null when it shows anything else. */
export function chatIdOf(path: string): number | null {
  const [, tab, raw] = path.split("/");
  return tab === "assistant" ? parseChatId(raw) : null;
}

/**
 * Away this long, the conversation you left open isn't where you are any
 * more: coming back, the Coach tab starts from its list — and anything the
 * coach has sent since — rather than yesterday's thread.
 */
export const STALE_CHAT_MS = 30 * 60_000;

type Navigate = ReturnType<typeof useNavigate>;

/**
 * Navigations run one after another: an unwind has to land before the next
 * one looks at where we are, and two arriving together — a notification tap
 * and the resume it caused — mustn't interleave.
 */
let queue: Promise<void> = Promise.resolve();

/** `go(path)`: show `path`, keeping the history in its one shape. */
export function useGo(): (to: string) => void {
  const navigate = useNavigate();
  return useCallback(
    (to: string) => {
      queue = queue
        .then(() => goNow(navigate, to))
        .catch((e) => console.warn("Navigation failed", e));
    },
    [navigate],
  );
}

/**
 * A page's ‹ Back: to its tab. That's one step back whenever the page was
 * reached through `go`, since the tab is right beneath it — and if it somehow
 * isn't, the tab is put there instead of leaving the app.
 */
export function useUp(): () => void {
  const go = useGo();
  return useCallback(() => go(tabOf(window.location.pathname)), [go]);
}

function settled(step: (then: () => void) => void): Promise<void> {
  return new Promise((resolve) => step(resolve));
}

async function goNow(navigate: Navigate, to: string): Promise<void> {
  const here = window.location.pathname;
  if (to === here) return;
  const tab = tabOf(to);

  if (to !== tab && tabOf(here) === tab) {
    await settled(closeSheets);
    await navigate(to, { replace: here !== tab });
    return;
  }

  // React Router doesn't see the unwind land, so each branch below ends by
  // telling it where the history now is.
  await settled(unwindHistory);
  if (to === tab) {
    await navigate(tab, { replace: true });
    return;
  }
  // The tab goes underneath without being shown on the way — rendering it
  // would run its page for nothing — then the page on top. React Router reads
  // the URL again when a back lands on that entry, so it shows the tab then.
  // The state is in React Router's shape: it counts depth by `idx`.
  window.history.replaceState({ usr: null, key: newKey(), idx: pageIndex() }, "", tab);
  await navigate(to);
}

function newKey(): string {
  return Math.random().toString(36).slice(2, 10);
}
