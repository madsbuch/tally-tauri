/**
 * The conversation on a diary entry.
 *
 * An estimate invites two things. Sometimes it's "the cheese block was 7 g,
 * not 3 g" — new information, and every number in the entry follows from it,
 * so it goes back to the model that made the estimate and what comes back
 * replaces it. But just as often it's "why is that so high?", and the honest
 * answer to that is words, not a new set of numbers. Re-estimating a meal
 * because someone asked about it is how a diary stops being a record.
 *
 * So both live in one thread and the model decides which it got. The thread is
 * kept: what was asked, what was answered, and — beside the messages that
 * moved something — exactly what they moved, and the entry they moved it from.
 * A number in this app should always be traceable to the sentence that set it.
 */
import {
  addEntryMessage,
  getSetting,
  listEntryMessages,
  updateFoodEntry,
  updateWorkout,
} from "./db";
import { askAboutMealEntry, askAboutWorkoutEntry } from "./openrouter";
import { readPhotoDataUrl } from "./photos";
import { withBackgroundTask } from "./background";
import { NUTRIENT_DEFS } from "./nutrients";
import { DEFAULT_VISION_MODEL, SETTING_KEYS } from "./types";
import type { EntryKind, EntryMessage, FoodEntry, Workout } from "./types";

/** What one message did, once it's been said and done. */
export interface EntryReply {
  /** What the assistant said back. */
  reply: string;
  /**
   * Field-by-field differences, already worded for display; [] = it only
   * talked. The rewritten description isn't among them — it changes on nearly
   * every correction and runs to a sentence, which would bury the figures
   * people are actually checking. It's on the page under Notes either way.
   */
  changes: string[];
}

const round = (n: number): number => Math.round(n * 100) / 100;

function changed(label: string, from: unknown, to: unknown, unit = ""): string | null {
  const a = typeof from === "number" ? round(from) : (from ?? "—");
  const b = typeof to === "number" ? round(to) : (to ?? "—");
  if (String(a) === String(b)) return null;
  const suffix = unit ? ` ${unit}` : "";
  return `${label}: ${a}${a === "—" ? "" : suffix} → ${b}${b === "—" ? "" : suffix}`;
}

/** Every difference between two versions of a meal, in display order. */
function diffMeal(before: FoodEntry, after: FoodEntry): string[] {
  const changes: string[] = [];
  const t = changed("Title", before.title, after.title);
  if (t) changes.push(t);
  for (const d of NUTRIENT_DEFS) {
    const c = changed(d.label, before.nutrients[d.key], after.nutrients[d.key], d.unit);
    if (c) changes.push(c);
  }
  return changes;
}

function diffWorkout(before: Workout, after: Workout): string[] {
  const changes: string[] = [];
  for (const c of [
    changed("Title", before.title, after.title),
    changed("Burned", before.calories_burned, after.calories_burned, "kcal"),
    changed("Duration", before.duration_min, after.duration_min, "min"),
  ]) {
    if (c) changes.push(c);
  }
  return changes;
}

async function keyAndModel(): Promise<{ apiKey: string; model: string }> {
  const apiKey = await getSetting(SETTING_KEYS.openrouterApiKey);
  if (!apiKey) throw new Error("Add your OpenRouter API key in Settings first");
  const model = (await getSetting(SETTING_KEYS.visionModel)) || DEFAULT_VISION_MODEL;
  return { apiKey, model };
}

/** The entry's own photo as a data URL, or nothing when it has none. */
async function photoOf(path: string | null): Promise<string | undefined> {
  if (!path) return undefined;
  try {
    return await readPhotoDataUrl(path);
  } catch {
    // A missing file shouldn't cost the answer; the text still stands.
    return undefined;
  }
}

/** Which table an entry lives in, from the shape of the entry itself. */
function kindOf(entry: FoodEntry | Workout): EntryKind {
  return "eaten_at" in entry ? "meal" : "workout";
}

/**
 * The thread as the model should read it: what was said, and what saying it
 * did. Without the change lines it can't tell an answer it gave from a
 * correction it applied, and offers to fix something it already fixed.
 */
function asHistory(messages: EntryMessage[]): { role: "user" | "assistant"; text: string }[] {
  return messages.map((m) => ({
    role: m.role,
    text:
      m.changes.length > 0
        ? `${m.text}\n[applied: ${m.changes.join("; ")}]`
        : m.text,
  }));
}

/**
 * Say something to an entry: a question, a correction, or both at once.
 *
 * Nothing is written until the answer is in hand, so a failed request leaves
 * the thread exactly as it was and the words back in the box to try again.
 */
export async function sendEntryMessage(
  entry: FoodEntry | Workout,
  message: string,
): Promise<EntryReply> {
  const { apiKey, model } = await keyAndModel();
  const kind = kindOf(entry);
  const history = asHistory(await listEntryMessages(kind, entry.id));
  const imageDataUrl = await photoOf(entry.photo_path);

  const changes: string[] = [];
  let before: FoodEntry | Workout | null = null;
  let reply: string;

  if ("eaten_at" in entry) {
    const answer = await withBackgroundTask("Asking about an entry", () =>
      askAboutMealEntry({
        apiKey,
        model,
        history,
        message,
        imageDataUrl,
        current: {
          title: entry.title,
          description: entry.description,
          nutrients: entry.nutrients,
        },
      }),
    );
    reply = answer.reply;
    if (answer.entry) {
      // Anything the model didn't mention is left exactly as it was.
      const after: FoodEntry = {
        ...entry,
        title: answer.entry.title ?? entry.title,
        description: answer.entry.description ?? entry.description,
        nutrients: answer.entry.nutrients ?? entry.nutrients,
        // The numbers are this model's now, whoever estimated them first.
        model_id: model,
      };
      changes.push(...diffMeal(entry, after));
      if (changes.length > 0 || after.description !== entry.description) {
        before = entry;
        await updateFoodEntry(after);
      }
    }
  } else {
    const answer = await withBackgroundTask("Asking about an entry", () =>
      askAboutWorkoutEntry({
        apiKey,
        model,
        history,
        message,
        imageDataUrl,
        current: {
          title: entry.title,
          description: entry.description,
          calories_burned: entry.calories_burned,
          duration_min: entry.duration_min,
        },
      }),
    );
    reply = answer.reply;
    if (answer.entry) {
      const after: Workout = {
        ...entry,
        title: answer.entry.title ?? entry.title,
        description: answer.entry.description ?? entry.description,
        calories_burned: answer.entry.calories_burned ?? entry.calories_burned,
        // Sent as empty means there is no duration; not sent means untouched.
        duration_min:
          answer.entry.duration_min === undefined
            ? entry.duration_min
            : answer.entry.duration_min,
        model_id: model,
      };
      changes.push(...diffWorkout(entry, after));
      if (changes.length > 0 || after.description !== entry.description) {
        before = entry;
        await updateWorkout(after);
      }
    }
  }

  await addEntryMessage({ kind, entryId: entry.id, role: "user", text: message });
  await addEntryMessage({
    kind,
    entryId: entry.id,
    role: "assistant",
    text: reply || "Done.",
    changes,
    before,
  });
  return { reply, changes };
}

/**
 * Put an entry back the way it was before the last message rewrote it.
 *
 * The undo is a message of its own rather than an erasure: the thread says
 * what was tried and that it was taken back, which is the truth, and reading
 * it later beats finding a change that quietly isn't there any more.
 */
export async function undoEntryChange(
  current: FoodEntry | Workout,
  before: FoodEntry | Workout,
): Promise<void> {
  const kind = kindOf(before);
  const changes =
    "eaten_at" in before && "eaten_at" in current
      ? diffMeal(current, before)
      : !("eaten_at" in before) && !("eaten_at" in current)
        ? diffWorkout(current, before)
        : [];
  if ("eaten_at" in before) await updateFoodEntry(before);
  else await updateWorkout(before);
  await addEntryMessage({
    kind,
    entryId: before.id,
    role: "assistant",
    text: "Put back the way it was.",
    changes,
  });
}
