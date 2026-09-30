/**
 * Android back button ↔ sheets.
 *
 * A sheet is not a page, so the hardware back button would otherwise navigate
 * the WebView out from under it — or leave the app entirely. Each open sheet
 * holds one history entry instead, and a single global popstate listener
 * closes the topmost one, so back peels them off one at a time.
 *
 * The fiddly part is that `history.pushState` is synchronous while
 * `history.back()` is not: the pop lands a tick or two later. Pushing in that
 * gap — a sheet opening as another closes, or React re-running the effect —
 * means the pending back consumes the NEW entry, and the next one eats a real
 * page instead. (That is how closing a sheet on an entry's page used to throw
 * you back to the diary.) So a push waits for every back we asked for to land
 * before it happens.
 *
 * Navigation (lib/navigation.ts) goes through here too, because a page can't
 * be pushed or unwound past open sheets without the same care: `closeSheets`
 * and `unwindHistory` take their entries away in one traversal and only then
 * let the navigation continue.
 */
import { useEffect, useRef } from "react";

/** Open sheet layers, topmost last. */
const sheetLayers: Layer[] = [];
/** Backs we have asked the browser for that haven't come back yet. */
let pendingBacks = 0;
/** Pushes held until they have. */
const queued: (() => void)[] = [];
/** Of those, the ones React Router mustn't see (see `rewind`). */
let hiddenPops = 0;
let popListenerInstalled = false;

interface Layer {
  close: () => void;
  /** Whether this layer got as far as owning a history entry. */
  pushed: boolean;
  /** Closed before its push ran — the push must not happen at all. */
  cancelled: boolean;
}

function whenSettled(fn: () => void): void {
  if (pendingBacks === 0) fn();
  else queued.push(fn);
}

function backLanded(): void {
  pendingBacks--;
  if (pendingBacks === 0) for (const fn of queued.splice(0)) fn();
}

function ensurePopListener(): void {
  if (popListenerInstalled) return;
  popListenerInstalled = true;
  // A rewind's landing is kept from React Router: it would render the page
  // the rewind passes through on its way — running that page's effects, like
  // the Coach list letting go of the open chat — when the navigation is about
  // to tell it where it really ends up. Capture phase, so this runs before
  // React Router's own listener and can stop it.
  window.addEventListener(
    "popstate",
    (e) => {
      if (hiddenPops === 0) return;
      hiddenPops--;
      e.stopImmediatePropagation();
      backLanded();
    },
    true,
  );
  window.addEventListener("popstate", () => {
    if (pendingBacks > 0) {
      backLanded();
      return;
    }
    const top = sheetLayers.pop();
    if (top) top.close();
  });
}

// Installed as the app loads — before React Router's listener exists — so the
// capture listener above comes first on any WebView, whatever its ordering.
if (typeof window !== "undefined") ensurePopListener();

/**
 * React Router's index for the entry we're on — how many pages sit beneath it.
 * A sheet's entry carries the index of the page it covers, so sheets don't
 * count.
 */
export function pageIndex(): number {
  const idx: unknown = window.history.state?.idx;
  return typeof idx === "number" && idx > 0 ? idx : 0;
}

/**
 * Close every open sheet and go back `pages(index)` pages beyond them, as one
 * traversal, then run `fn` once it has landed.
 *
 * The sheets are closed here rather than left to close themselves: each would
 * ask for a back of its own when it unmounts, and those land a tick apart —
 * the race this module exists to avoid. Taking a layer out of the list first
 * is what tells its cleanup that its entry is already accounted for.
 *
 * React Router never hears of the traversal, so `fn` must navigate — push or
 * replace — to bring it up to date with where the history now is.
 */
function rewind(pages: (index: number) => number, fn: () => void): void {
  whenSettled(() => {
    const layers = sheetLayers.splice(0);
    for (const layer of layers.reverse()) layer.close();
    const steps = layers.length + pages(pageIndex());
    if (steps === 0) {
      fn();
      return;
    }
    pendingBacks++;
    hiddenPops++;
    queued.push(fn);
    window.history.go(-steps);
  });
}

/**
 * Close any open sheets, then run `fn` once their entries are gone — before
 * pushing or replacing a page, so a sheet's late back can't take the new
 * entry with it. With no sheets open it waits only for backs already asked
 * for. `fn` must navigate (see `rewind`).
 */
export function closeSheets(fn: () => void): void {
  rewind(() => 0, fn);
}

/**
 * Go back to the first entry — the tab the history starts from — closing any
 * sheets on the way, then run `fn` there. `fn` must navigate (see `rewind`).
 */
export function unwindHistory(fn: () => void): void {
  rewind((index) => index, fn);
}

/**
 * While `open` is true, keep one history entry on the stack so the Android
 * back button closes this sheet (via `close`) instead of leaving the page.
 * Closing by button or backdrop gives that entry back.
 */
export function useSheetHistory(open: boolean, close: () => void): void {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    ensurePopListener();
    const layer: Layer = {
      close: () => closeRef.current(),
      pushed: false,
      cancelled: false,
    };
    whenSettled(() => {
      if (layer.cancelled) return;
      sheetLayers.push(layer);
      layer.pushed = true;
      // Carry the router's own state (its key and index) across: wiping it
      // leaves react-router unable to tell which way a later pop went.
      window.history.pushState({ ...window.history.state, sheet: true }, "");
    });
    return () => {
      layer.cancelled = true;
      const idx = sheetLayers.indexOf(layer);
      if (idx !== -1) sheetLayers.splice(idx, 1);
      // Only give back an entry we actually took. A layer closed by the back
      // button has already had its entry consumed by the pop that closed it.
      if (layer.pushed && idx !== -1) {
        pendingBacks++;
        window.history.back();
      }
    };
  }, [open]);
}
