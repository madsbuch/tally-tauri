/**
 * Android back button ↔ sheets.
 *
 * A sheet is not a page, so the hardware back button would otherwise navigate
 * the WebView out from under it — or leave the app entirely. Each open sheet
 * holds one history entry instead, and a single global popstate listener
 * closes the topmost one, so back peels them off one at a time.
 */
import { useEffect, useRef } from "react";

/** Open sheet layers, topmost last. */
const sheetLayers: { close: () => void }[] = [];
/** History entries we popped ourselves (button/backdrop close) — ignore their popstate. */
let consumePending = 0;
let popListenerInstalled = false;

function ensurePopListener(): void {
  if (popListenerInstalled) return;
  popListenerInstalled = true;
  window.addEventListener("popstate", () => {
    if (consumePending > 0) {
      consumePending--;
      return;
    }
    const top = sheetLayers.pop();
    if (top) top.close();
  });
}

/**
 * While `open` is true, keep one history entry on the stack so the Android
 * back button closes this sheet (via `close`) instead of leaving the page.
 * Closing by button/backdrop consumes the pushed entry with history.back().
 */
export function useSheetHistory(open: boolean, close: () => void): void {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    ensurePopListener();
    const layer = { close: () => closeRef.current() };
    sheetLayers.push(layer);
    window.history.pushState({ sheet: true }, "");
    return () => {
      const idx = sheetLayers.indexOf(layer);
      // Still on the stack → closed by button/backdrop, not by popstate:
      // remove it and consume the history entry we pushed.
      if (idx !== -1) {
        sheetLayers.splice(idx, 1);
        consumePending++;
        window.history.back();
      }
    };
  }, [open]);
}
