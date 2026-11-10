/**
 * Light / dark appearance.
 *
 * The palette lives in App.css as tokens. `data-theme="light" | "dark"` on
 * <html> picks one: the pinned theme from Settings, or — following the system
 * — whichever the phone is in. Android's WebView can't be trusted to answer
 * `prefers-color-scheme` (it only says dark when the app theme declares it,
 * and never updates while the app runs), so there MainActivity is asked
 * directly and announces changes with a `tally:system-theme` event. The media
 * query in App.css only covers the moment before this script runs, and
 * browsers.
 *
 * The choice is kept in localStorage rather than the settings table: it has to
 * be known synchronously, before the first paint, or the app flashes the wrong
 * colours while SQLite opens. It's a per-device preference anyway.
 *
 * Android draws its own status/navigation bar icons; the page tells
 * MainActivity which way they should go through the `TallyTheme` bridge, so a
 * pinned dark theme on a light phone doesn't end up with dark icons on dark.
 */

export type ThemePref = "system" | "light" | "dark";

const KEY = "tally.theme";
const PREFS: readonly ThemePref[] = ["system", "light", "dark"];

/** Surfaces the WebView can't paint itself: matches --bg in each theme. */
const BG = { light: "#f3f5ee", dark: "#141a16" } as const;

declare global {
  interface Window {
    /** Injected by MainActivity on Android; absent elsewhere. */
    TallyTheme?: { setDark(dark: boolean): void; isSystemDark?(): boolean };
  }
}

const darkQuery = (): MediaQueryList | null =>
  typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;

export function getThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return PREFS.find((p) => p === v) ?? "system";
  } catch {
    return "system";
  }
}

/** The phone's dark mode: Android's own answer where there is one. */
function systemDark(): boolean {
  try {
    const native = window.TallyTheme?.isSystemDark?.();
    if (typeof native === "boolean") return native;
  } catch {
    // Fall back to the media query.
  }
  return darkQuery()?.matches ?? false;
}

function resolved(pref: ThemePref): "light" | "dark" {
  if (pref !== "system") return pref;
  return systemDark() ? "dark" : "light";
}

function apply(pref: ThemePref): void {
  const mode = resolved(pref);
  document.documentElement.setAttribute("data-theme", mode);

  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.appendChild(meta);
  }
  meta.content = BG[mode];

  try {
    window.TallyTheme?.setDark(mode === "dark");
  } catch {
    // The bridge is best-effort; the page itself is already themed.
  }
}

const listeners = new Set<() => void>();

export function setThemePref(pref: ThemePref): void {
  try {
    if (pref === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, pref);
  } catch {
    // Storage unavailable: still switch for this session.
  }
  current = pref;
  apply(pref);
  listeners.forEach((l) => l());
}

let current: ThemePref = "system";

/** For useSyncExternalStore in the Settings picker. */
export function subscribeThemePref(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function currentThemePref(): ThemePref {
  return current;
}

/** Call once, before React renders. */
export function installTheme(): void {
  current = getThemePref();
  apply(current);
  // Following the system: re-theme when it flips — Android says so itself,
  // a browser through the media query.
  const follow = () => {
    if (current === "system") apply(current);
  };
  darkQuery()?.addEventListener("change", follow);
  window.addEventListener("tally:system-theme", follow);
  // Back from the background: the phone may have switched while the app was
  // away and the event been missed.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") follow();
  });
}
