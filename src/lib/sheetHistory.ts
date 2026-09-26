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
 */
import { useEffect, useRef } from "react";

/** Open sheet layers, topmost last. */
const sheetLayers: Layer[] = [];
/** Backs we have asked the browser for that haven't come back yet. */
let pendingBacks = 0;
/** Pushes held until they have. */
const queued: (() => void)[] = [];
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

function ensurePopListener(): void {
  if (popListenerInstalled) return;
  popListenerInstalled = true;
  window.addEventListener("popstate", () => {
    if (pendingBacks > 0) {
      pendingBacks--;
      if (pendingBacks === 0) for (const fn of queued.splice(0)) fn();
      return;
    }
    const top = sheetLayers.pop();
    if (top) top.close();
  });
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
