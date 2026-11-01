/**
 * One-time move of the old supplement logs into the diary.
 *
 * Supplements used to have their own catalogue and log; they are food now
 * (see the diary agent's prompt), logged as 💊 food entries with nutrients for
 * the amount taken. This turns every remaining supplement log into such an
 * entry, at the same time and day, with the catalogue's per-dose nutrients
 * scaled by the doses taken.
 *
 * A supplement saved without any nutrients (the agent used to create them
 * that way) gets them estimated first, once per supplement. When that can't
 * happen right now — no API key, offline — its logs are left exactly as they
 * are and the next app start tries again, so nothing is converted into an
 * entry that silently counts as zero.
 */
import {
  convertSupplementLogToFood,
  getSetting,
  listAllSupplementLogs,
} from "./db";
import { analyzeSupplement } from "./openrouter";
import { notifyDiaryChanged } from "./agent";
import { sanitizeNutrients, scaleNutrients } from "./nutrients";
import { DEFAULT_VISION_MODEL, SETTING_KEYS } from "./types";
import type { Nutrients, SupplementLogWithSupplement } from "./types";

const fmt = (n: number): string =>
  n.toLocaleString("en-US", { maximumFractionDigits: 2, useGrouping: false });

const COUNTED_UNITS = new Set(["capsule", "tablet", "drop"]);

/** "Fish oil 1600 mg", "Vitamin D 2 capsules", "Husk × 2". */
function titleOf(log: SupplementLogWithSupplement): string {
  if (log.dose_amount != null) {
    const total = log.dose_amount * log.amount;
    const unit = log.dose_unit ?? "";
    const plural = COUNTED_UNITS.has(unit) && total !== 1 ? `${unit}s` : unit;
    return `${log.name} ${fmt(total)}${plural ? ` ${plural}` : ""}`.trim();
  }
  return log.amount === 1 ? log.name : `${log.name} × ${fmt(log.amount)}`;
}

/** What one dose is, for the estimate and the description. */
function doseText(log: SupplementLogWithSupplement): string | null {
  if (log.dose_amount == null) return null;
  return `${fmt(log.dose_amount)}${log.dose_unit ? ` ${log.dose_unit}` : ""}`;
}

let running: Promise<number> | null = null;

/** Convert what can be converted; resolves to how many logs were moved. */
export function convertSupplementLogs(): Promise<number> {
  running ??= run().finally(() => {
    running = null;
  });
  return running;
}

async function run(): Promise<number> {
  const logs = await listAllSupplementLogs();
  if (logs.length === 0) return 0;

  // Per-dose nutrients and how they were arrived at, per supplement.
  const perDose = new Map<number, { nutrients: Nutrients; model: string | null; notes: string | null }>();
  const needEstimate = new Map<number, SupplementLogWithSupplement>();
  for (const l of logs) {
    if (Object.keys(l.nutrients).length > 0) {
      perDose.set(l.supplement_id, { nutrients: l.nutrients, model: null, notes: null });
    } else {
      needEstimate.set(l.supplement_id, l);
    }
  }

  if (needEstimate.size > 0) {
    const apiKey = await getSetting(SETTING_KEYS.openrouterApiKey);
    const model = (await getSetting(SETTING_KEYS.visionModel)) || DEFAULT_VISION_MODEL;
    if (apiKey) {
      for (const [id, l] of needEstimate) {
        const dose = doseText(l);
        try {
          const r = await analyzeSupplement(
            apiKey,
            model,
            dose ? `${l.name}, ${dose} per dose` : `${l.name} (one typical serving per dose)`,
          );
          perDose.set(id, {
            nutrients: sanitizeNutrients(r.nutrients),
            model,
            notes: r.notes.trim() || null,
          });
        } catch (e) {
          // Left for the next start; the old log still shows and counts.
          console.warn(`Couldn't estimate supplement "${l.name}"`, e);
        }
      }
    }
  }

  let moved = 0;
  for (const l of logs) {
    const est = perDose.get(l.supplement_id);
    if (!est) continue;
    const dose = doseText(l);
    const taken = `${fmt(l.amount)} dose${l.amount === 1 ? "" : "s"}${dose ? ` of ${dose}` : ""}`;
    const description = [
      `Logged as a supplement: ${taken}.`,
      est.model ? `Nutrients estimated per dose${est.notes ? ` — ${est.notes}` : "."}` : null,
    ]
      .filter(Boolean)
      .join(" ");
    await convertSupplementLogToFood(l.id, {
      eaten_at: l.taken_at,
      title: titleOf(l),
      description,
      nutrients: sanitizeNutrients(scaleNutrients(est.nutrients, l.amount)),
      model_id: est.model,
      icon: "supplement",
      day: l.day,
      tz_offset_min: l.tz_offset_min,
    });
    moved++;
  }
  if (moved > 0) notifyDiaryChanged();
  return moved;
}
