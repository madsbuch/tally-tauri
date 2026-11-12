/**
 * Observations: what you notice about yourself, as something you can log.
 *
 * Feelings, mostly, at first, but it became the place for anything noticed:
 * what the body did, an urge, a thought or a rule-shaped belief coming up.
 * The screen says "observation"; the code and tables still say "state", which
 * is the same thing under its first name.
 *
 * The diary was built around what goes in and what gets burned, which is the
 * measurable half of a day. The other half — bloated after lunch, depressive
 * thoughts in the afternoon, wired at midnight — is what those numbers are
 * usually being kept *for*. Logged with a time on it, it can sit next to the
 * meals and the sleep and be asked the obvious question: does this follow that?
 *
 * The observations themselves are a list the user owns (the `state_categories`
 * table), not a vocabulary shipped with the app. What is worth noticing is
 * personal, and a screen of plausible guesses is mostly clutter around the two
 * or three things someone actually watches. So it starts at three and grows
 * when they add to it — and because a name they invent can't be in anyone's
 * lookup table, the emoji for a new one is asked of the model.
 */

import type { StateCategory, StateLog, StateTag, TaggingStatus } from "./types";

/** A state logged before its category existed, or whose icon didn't resolve. */
export const STATE_FALLBACK_GLYPH = "💭";

/** The emoji stored with a state or a category; 💭 when there isn't one. */
export function stateGlyph(icon: string | null | undefined): string {
  return icon || STATE_FALLBACK_GLYPH;
}

/** Categories match on their words, not their case or their spacing. */
export function stateKey(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, " ");
}

export function isTaggingStatus(v: unknown): v is TaggingStatus {
  return v === "pending" || v === "failed";
}

/**
 * Tags named by a model (or typed loosely) matched onto their list. Only what
 * is on the list comes back, with the list's spelling and icon: a tag the
 * model made up would be the start of near-duplicates nobody asked for.
 */
export function tagsFromList(labels: readonly string[], list: readonly StateCategory[]): StateTag[] {
  const byKey = new Map(list.map((c) => [stateKey(c.label), c]));
  const out: StateTag[] = [];
  const seen = new Set<string>();
  for (const l of labels) {
    const c = byKey.get(stateKey(l));
    if (!c || seen.has(c.label)) continue;
    seen.add(c.label);
    out.push({ label: c.label, icon: c.icon });
  }
  return out;
}

/** The icons an observation shows: one per tag, or 💭 with none. */
export function stateGlyphs(log: Pick<StateLog, "tags">): string[] {
  return log.tags.length > 0 ? log.tags.map((t) => stateGlyph(t.icon)) : [STATE_FALLBACK_GLYPH];
}

/** What an observation is called: its tags, else its note, else just that. */
export function stateTitle(log: Pick<StateLog, "tags" | "note">): string {
  if (log.tags.length > 0) return log.tags.map((t) => t.label).join(" · ");
  const note = log.note?.trim().replace(/\s+/g, " ");
  if (!note) return "Observation";
  return note.length > 60 ? `${note.slice(0, 60).trimEnd()}…` : note;
}
