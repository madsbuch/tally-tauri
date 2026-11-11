/**
 * Which model the coach runs on, and how much it may spend.
 *
 * The coach used to share the photo analyser's model, which has to be a
 * vision model. The coach only ever reads text, so it gets its own setting
 * and can run on something cheaper. Check-ins can go cheaper still: they run
 * unasked, so their cost adds up without anyone choosing to spend it.
 */
import { getSetting } from "./db";
import { DEFAULT_VISION_MODEL, SETTING_KEYS } from "./types";

export type CoachPurpose = "chat" | "checkin";

/** Reasoning effort sent to OpenRouter; "" leaves the model at its default. */
export type CoachReasoning = "" | "low" | "none";

export const COACH_REASONING_OPTIONS: { value: CoachReasoning; label: string }[] = [
  { value: "", label: "Model default" },
  { value: "low", label: "Low" },
  { value: "none", label: "Off" },
];

async function setting(key: string): Promise<string> {
  return ((await getSetting(key).catch(() => null)) ?? "").trim();
}

/** The model for a purpose, falling back check-in → coach → vision model. */
export async function coachModelFor(purpose: CoachPurpose): Promise<string> {
  const [checkin, coach, vision] = await Promise.all([
    setting(SETTING_KEYS.checkinModel),
    setting(SETTING_KEYS.coachModel),
    setting(SETTING_KEYS.visionModel),
  ]);
  if (purpose === "checkin" && checkin) return checkin;
  return coach || vision || DEFAULT_VISION_MODEL;
}

export function parseCoachReasoning(raw: string | null | undefined): CoachReasoning {
  return raw === "low" || raw === "none" ? raw : "";
}

export async function coachReasoning(): Promise<CoachReasoning> {
  return parseCoachReasoning(await setting(SETTING_KEYS.coachReasoning));
}

/** Parse a stored USD budget; null when unset or not a positive number. */
export function parseBudget(raw: string | null | undefined): number | null {
  if (!raw || raw.trim() === "") return null;
  const n = Number(raw.trim().replace(",", "."));
  return isFinite(n) && n > 0 ? n : null;
}

/** The check-ins' daily cap in USD, or null for no cap. */
export async function checkinDailyBudget(): Promise<number | null> {
  return parseBudget(await setting(SETTING_KEYS.checkinDailyBudget));
}

/** "$0.42", or "<$0.01" for the small amounts most turns cost. */
export function formatUsd(usd: number): string {
  if (usd <= 0) return "$0.00";
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}
