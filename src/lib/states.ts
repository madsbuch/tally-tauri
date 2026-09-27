/**
 * How you feel, as something you can log.
 *
 * The diary was built around what goes in and what gets burned, which is the
 * measurable half of a day. The other half — bloated after lunch, depressive
 * thoughts in the afternoon, wired at midnight — is what those numbers are
 * usually being kept *for*. Logged with a time on it, it can sit next to the
 * meals and the sleep and be asked the obvious question: does this follow that?
 *
 * Presets exist so logging one costs a single tap at the moment you least feel
 * like typing. They are a starting point, not a vocabulary: anything typed in
 * the box is just as much a state, and the ones you type come back as chips of
 * their own next time (see `listRecentStateLabels`).
 *
 * As with entry icons, the KEY is stored and the glyph is looked up — the
 * wording and the emoji can be retuned later without rewriting the database,
 * and an unknown key degrades to 💭 rather than rendering garbage.
 */

export interface StatePreset {
  /** Stable id stored in `state_logs.icon`. */
  key: string;
  /** What the chip says, and what the row is called when it's logged. */
  label: string;
  glyph: string;
}

/** A state with no preset behind it — something they typed themselves. */
export const STATE_FALLBACK_GLYPH = "💭";

/**
 * The starting vocabulary: mind and body, and not only the bad days.
 *
 * A diary of nothing but symptoms reads as a case file and stops being worth
 * opening, so the good states are here on the same row as the rest — and they
 * are the ones that make a correlation mean anything, since "bloated" only
 * tells you something if some days aren't.
 */
export const STATE_PRESETS: StatePreset[] = [
  { key: "low_mood", label: "Depressive thoughts", glyph: "🌧️" },
  { key: "anxious", label: "Anxious", glyph: "😰" },
  { key: "stressed", label: "Stressed", glyph: "😣" },
  { key: "irritable", label: "Irritable", glyph: "😤" },
  { key: "brain_fog", label: "Brain fog", glyph: "🌫️" },
  { key: "bloated", label: "Bloated", glyph: "🫧" },
  { key: "stomach_ache", label: "Stomach ache", glyph: "😖" },
  { key: "nauseous", label: "Nauseous", glyph: "🤢" },
  { key: "heartburn", label: "Heartburn", glyph: "🔥" },
  { key: "headache", label: "Headache", glyph: "🤕" },
  { key: "tired", label: "Tired", glyph: "🥱" },
  { key: "cravings", label: "Cravings", glyph: "🍫" },
  { key: "energetic", label: "Energetic", glyph: "⚡" },
  { key: "calm", label: "Calm", glyph: "🌿" },
  { key: "good_mood", label: "Good mood", glyph: "🙂" },
];

const BY_KEY = new Map(STATE_PRESETS.map((p) => [p.key, p]));

/** The glyph for a stored icon key; 💭 for anything unrecognised. */
export function stateGlyph(key: string | null | undefined): string {
  return (key && BY_KEY.get(key)?.glyph) || STATE_FALLBACK_GLYPH;
}

/** The preset behind a stored key, when there is one. */
export function statePreset(key: string | null | undefined): StatePreset | null {
  return (key && BY_KEY.get(key)) || null;
}

/** Preset keys, for the enum the capture agent picks from. */
export function statePresetKeys(): string[] {
  return STATE_PRESETS.map((p) => p.key);
}

/** The preset whose label matches, for turning a typed name back into a key. */
export function presetForLabel(label: string): StatePreset | null {
  const l = label.trim().toLowerCase();
  return STATE_PRESETS.find((p) => p.label.toLowerCase() === l) ?? null;
}
