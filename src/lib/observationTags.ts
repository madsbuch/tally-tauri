/**
 * Tagging an observation from what they wrote.
 *
 * Writing "loads of gas after the lentils" and pressing Log should be enough:
 * the model reads the note and puts the matching tags from their list on it
 * (💨 Farty, say). Two rules keep it from getting in the way:
 *
 * - **Hand-picked tags are final.** It only runs on an observation saved with
 *   a note and no tags. Pick even one yourself and it stays out.
 * - **Only their list.** It never invents a tag; when nothing fits, the
 *   observation stays untagged and can be tagged by hand from its page.
 *
 * It runs after Log, in the background like a capture, so saving is instant.
 * An observation waiting on it is `tagging = "pending"` in the database,
 * which is how an interrupted run gets picked up again on the next start or
 * resume. One that couldn't be tagged (no key, no network) is "failed" and
 * waits for a hand.
 */
import {
  getSetting,
  getStateLog,
  listStateCategories,
  listStateLogsAwaitingTags,
  setStateLogTags,
} from "./db";
import { notifyDiaryChanged } from "./agent";
import { onAppResume } from "./appLifecycle";
import { withBackgroundTask } from "./background";
import { coachModelFor } from "./coachModel";
import { suggestObservationTags } from "./openrouter";
import { tagsFromList } from "./states";
import { SETTING_KEYS } from "./types";

/** Observations being tagged right now, so a resume doesn't start a second run. */
const running = new Set<number>();

/** Tag one observation that is waiting for it. Never throws. */
export async function tagObservation(id: number): Promise<void> {
  if (running.has(id)) return;
  running.add(id);
  try {
    await withBackgroundTask("Tagging an observation", async () => {
      const log = await getStateLog(id);
      if (!log || log.tagging !== "pending") return;
      const note = log.note?.trim() ?? "";
      const list = await listStateCategories();
      // Nothing to read or nothing to pick from: settled, untagged.
      if (!note || list.length === 0) {
        await setStateLogTags(id, log.tags, null);
        return;
      }
      const apiKey = await getSetting(SETTING_KEYS.openrouterApiKey);
      if (!apiKey) {
        await setStateLogTags(id, log.tags, "failed");
        return;
      }
      try {
        // The cheapest text model they've set: this is a small, unasked job.
        const model = await coachModelFor("checkin");
        const picked = await suggestObservationTags(
          apiKey,
          model,
          note,
          list.map((c) => c.label),
        );
        // They may have tagged it by hand while the model was thinking.
        const now = await getStateLog(id);
        if (!now || now.tagging !== "pending") return;
        await setStateLogTags(id, tagsFromList(picked, list), null);
      } catch {
        await setStateLogTags(id, log.tags, "failed");
      }
    });
  } catch (e) {
    console.error("Tagging observation failed", e);
  } finally {
    running.delete(id);
    notifyDiaryChanged();
  }
}

/** Pick up observations whose tagging was interrupted (on start and resume). */
export async function resumePendingTags(): Promise<void> {
  const pending = await listStateLogsAwaitingTags().catch(() => []);
  for (const log of pending) void tagObservation(log.id);
}

/** Call once on app start; returns a cleanup function. */
export function installTaggingLifecycle(): () => void {
  return onAppResume(() => void resumePendingTags());
}
