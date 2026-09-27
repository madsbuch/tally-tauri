/**
 * How you feel, as something you can log.
 *
 * The diary was built around what goes in and what gets burned, which is the
 * measurable half of a day. The other half — bloated after lunch, depressive
 * thoughts in the afternoon, wired at midnight — is what those numbers are
 * usually being kept *for*. Logged with a time on it, it can sit next to the
 * meals and the sleep and be asked the obvious question: does this follow that?
 *
 * The states themselves are a list the user owns (the `state_categories`
 * table), not a vocabulary shipped with the app. What is worth noticing is
 * personal, and a screen of plausible guesses is mostly clutter around the two
 * or three things someone actually watches. So it starts at three and grows
 * when they add to it — and because a name they invent can't be in anyone's
 * lookup table, the emoji for a new one is asked of the model.
 */

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
