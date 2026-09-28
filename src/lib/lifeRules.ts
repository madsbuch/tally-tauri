/**
 * Rules for living, as something you can write down and watch.
 *
 * "I must always do things perfectly." "I'm a man, so I'm dangerous." Nobody
 * picked these; they were learned, and they run quietly underneath whole days.
 * Writing one down is the first step of seeing it, and noting each time it
 * comes up — what set it off, how true it felt, whether you did what it said
 * — is how you find out where it lives and whether it is losing its grip.
 *
 * Two rules for the app itself follow from that:
 *
 * - **Their words, verbatim.** A rule is stored exactly as it was put. The
 *   model never shortens, softens or tidies it; a reworded rule is a
 *   different rule, and rewording is the person's work, not ours.
 * - **Nothing becomes a rule without them.** The diary agent may *suggest*
 *   one it heard in a note ("have to earn a rest, as always"), but a
 *   suggestion waits for a Keep before it counts. Only "new rule: …" or a
 *   rule they typed in themselves is kept straight away.
 */
import type { LifeRuleStatus, RuleActedOn } from "./types";

/** The glyph a rule shows in the diary. */
export const RULE_GLYPH = "🧭";

/**
 * Rules match on their words — not their case, spacing, quotes or the full
 * stop at the end — so writing one down twice finds the first one.
 */
export function ruleKey(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/^["'“”„«»]+|["'“”„«».!]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function isRuleStatus(v: unknown): v is LifeRuleStatus {
  return v === "suggested" || v === "kept" || v === "archived";
}

export function isActedOn(v: unknown): v is RuleActedOn {
  return v === "yes" || v === "partly" || v === "no";
}

/** A belief rating as a whole percentage, or null when it isn't one. */
export function clampBelief(v: unknown): number | null {
  const n = typeof v === "string" ? parseFloat(v) : v;
  if (typeof n !== "number" || !isFinite(n)) return null;
  // "0.8" from a model that thought in fractions means 80%, not 1%.
  const pct = n > 0 && n < 1 ? n * 100 : n;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

export const ACTED_ON_LABEL: Record<RuleActedOn, string> = {
  yes: "Followed it",
  partly: "Partly followed",
  no: "Didn't follow it",
};
