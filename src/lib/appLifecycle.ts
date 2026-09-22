/**
 * App foreground/background transitions, shared by everything that talks to
 * the network.
 *
 * On mobile the OS suspends the WebView the moment the app leaves the
 * foreground: in-flight requests to OpenRouter are dropped and timers are
 * throttled, so a long AI round can fail through no fault of the model, the
 * key, or the network. Two rules follow, and every AI caller obeys them:
 *
 * 1. Work interrupted that way is NOT a failure. It stays resumable instead
 *    of being burned into a permanent error the user has to clear by hand.
 * 2. It is picked up again the moment the app returns to the foreground.
 *
 * This does not make the work run *while* suspended — only a native
 * foreground service could do that. It makes suspension harmless.
 */

/** Epoch ms of the last time the app was backgrounded; 0 before any hide. */
let lastHiddenAt = 0;
let installed = false;
const resumeHandlers = new Set<() => void>();

export function isAppHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/**
 * True when the app was suspended at any point since `startedAtMs` — i.e. a
 * failure since then is far more likely the OS dropping our work than a real
 * problem worth reporting.
 */
export function wasSuspendedSince(startedAtMs: number): boolean {
  return isAppHidden() || lastHiddenAt >= startedAtMs;
}

/**
 * Run `fn` every time the app returns to the foreground. Returns an
 * unsubscribe function.
 */
export function onAppResume(fn: () => void): () => void {
  resumeHandlers.add(fn);
  return () => resumeHandlers.delete(fn);
}

/**
 * Start tracking foreground/background transitions. Call once on app start;
 * returns a cleanup function.
 */
export function installAppLifecycle(): () => void {
  if (installed || typeof document === "undefined") return () => {};
  installed = true;

  const fire = () => {
    for (const fn of resumeHandlers) {
      try {
        fn();
      } catch (e) {
        console.warn("Resume handler failed", e);
      }
    }
  };
  const onVisibility = () => {
    if (document.visibilityState === "hidden") lastHiddenAt = Date.now();
    else fire();
  };

  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("focus", fire);
  return () => {
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("focus", fire);
    installed = false;
  };
}
