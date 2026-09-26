/**
 * Correcting an entry by telling the app what was wrong with it.
 *
 * "Oh, the cheese block was 7 g, not 3 g." Every number in the entry follows
 * from that, and editing them one by one — protein, fat, sodium, the lot — is
 * exactly the work the estimate was supposed to save. So the correction goes
 * back to the model that made the estimate, along with the entry as it stands
 * and its own photo when it has one, and what comes back replaces it.
 *
 * The entry it replaced is handed back to the caller so the page can offer an
 * undo: a re-estimate is still an estimate, and it can be wrong in its own way.
 */
import { getSetting, updateFoodEntry, updateWorkout } from "./db";
import { reviseMealEntry, reviseWorkoutEntry } from "./openrouter";
import { readPhotoDataUrl } from "./photos";
import { withBackgroundTask } from "./background";
import { NUTRIENT_DEFS } from "./nutrients";
import { DEFAULT_VISION_MODEL, SETTING_KEYS } from "./types";
import type { FoodEntry, Workout } from "./types";

export interface Revision<T> {
  /** The entry as it was, for undo. */
  before: T;
  /** The model's one-line account of what it changed. */
  note: string;
  /** Field-by-field differences, already worded for display. */
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
    // A missing file shouldn't cost the correction; the text still stands.
    return undefined;
  }
}

export async function reviseMeal(
  entry: FoodEntry,
  instruction: string,
): Promise<Revision<FoodEntry>> {
  const { apiKey, model } = await keyAndModel();
  const revised = await withBackgroundTask("Correcting an entry", async () =>
    reviseMealEntry({
      apiKey,
      model,
      instruction,
      imageDataUrl: await photoOf(entry.photo_path),
      current: {
        title: entry.title,
        description: entry.description,
        nutrients: entry.nutrients,
      },
    }),
  );

  const changes: string[] = [];
  const t = changed("Title", entry.title, revised.title);
  if (t) changes.push(t);
  for (const d of NUTRIENT_DEFS) {
    const c = changed(d.label, entry.nutrients[d.key], revised.nutrients[d.key], d.unit);
    if (c) changes.push(c);
  }

  await updateFoodEntry({
    ...entry,
    title: revised.title,
    description: revised.description.trim() || entry.description,
    nutrients: revised.nutrients,
    // The numbers are this model's now, whoever estimated them first.
    model_id: model,
  });
  return { before: entry, note: revised.note, changes };
}

export async function reviseWorkout(
  workout: Workout,
  instruction: string,
): Promise<Revision<Workout>> {
  const { apiKey, model } = await keyAndModel();
  const revised = await withBackgroundTask("Correcting an entry", async () =>
    reviseWorkoutEntry({
      apiKey,
      model,
      instruction,
      imageDataUrl: await photoOf(workout.photo_path),
      current: {
        title: workout.title,
        description: workout.description,
        calories_burned: workout.calories_burned,
        duration_min: workout.duration_min,
      },
    }),
  );

  const changes: string[] = [];
  for (const c of [
    changed("Title", workout.title, revised.title),
    changed("Burned", workout.calories_burned, revised.calories_burned, "kcal"),
    changed("Duration", workout.duration_min, revised.duration_min, "min"),
  ]) {
    if (c) changes.push(c);
  }

  await updateWorkout({
    ...workout,
    title: revised.title,
    description: revised.description.trim() || workout.description,
    calories_burned: revised.calories_burned,
    duration_min: revised.duration_min,
    model_id: model,
  });
  return { before: workout, note: revised.note, changes };
}

/** Put an entry back exactly as it was before a correction. */
export async function undoRevision(before: FoodEntry | Workout): Promise<void> {
  if ("eaten_at" in before) await updateFoodEntry(before);
  else await updateWorkout(before);
}
