/**
 * Keeps the app's process alive while AI work is in flight.
 *
 * Android freezes a backgrounded app's process and eventually kills it. That
 * is what dropped an in-flight OpenRouter request the moment the user
 * switched away mid-answer, and why a photo captured just before locking the
 * phone sat unanalysed until the app was reopened.
 *
 * Wrapping the work in `withBackgroundTask` runs an Android foreground
 * service for its duration (see src-tauri/plugins/background), so the process
 * stays in the foreground importance class and the work actually finishes
 * with the app closed. A small notification says what is running.
 *
 * Tasks are ref-counted: several captures can analyse at once, and the
 * service only stops when the last of them is done. Everywhere else — desktop,
 * `bun run dev` in a plain browser, an Android build that refuses the service
 * — the invoke fails harmlessly and the work runs exactly as before, just
 * without protection from being frozen.
 */
import { invoke } from "@tauri-apps/api/core";

let nextId = 1;
/** Running tasks by id, in start order; the newest one names the notification. */
const active = new Map<number, string>();
/** The label currently shown by the service. */
let applied: string | null = null;
/**
 * Whether we believe the service is up. Tracked separately from the label so
 * a new task always starts it, even when it happens to carry the same label
 * as one the service's watchdog already stopped.
 */
let running = false;
/** Serializes begin/end so a quick start-stop can't land out of order. */
let queue: Promise<void> = Promise.resolve();

async function sync(): Promise<void> {
  let label: string | null = null;
  for (const l of active.values()) label = l;
  try {
    if (label == null) {
      if (!running) return;
      running = false;
      applied = null;
      await invoke("plugin:background|end_task");
    } else {
      if (running && label === applied) return;
      running = true;
      applied = label;
      await invoke("plugin:background|begin_task", { label });
    }
  } catch (e) {
    // Not fatal: only the protection is missing, never the work itself.
    console.warn("Background keepalive unavailable", e);
  }
}

function schedule(): Promise<void> {
  queue = queue.then(sync).catch(() => {});
  return queue;
}

/**
 * Run `fn` with the process held open, labelled for the notification.
 *
 * The service is started before `fn` begins and awaited: Android refuses to
 * start a foreground service from the background, so it has to go up while
 * the tap that triggered this is still what's on screen.
 */
export async function withBackgroundTask<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  const id = nextId++;
  active.set(id, label);
  await schedule();
  try {
    return await fn();
  } finally {
    active.delete(id);
    void schedule();
  }
}
