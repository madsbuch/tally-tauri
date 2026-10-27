/**
 * Blood readings: glucose and β-ketones off a finger-prick meter.
 *
 * Written against the FreeStyle Precision Neo, which reads both off the same
 * device with different strips, and whose limits are the ranges below — a
 * number outside them isn't something the meter could have shown (it says LO
 * or HI instead), so it's a typo, and almost always the other glucose unit.
 *
 * Everything is kept in mmol/L. Ketones are only ever read in it, and glucose
 * in the same unit is what lets the two be divided: glucose ÷ ketones is the
 * glucose–ketone index, the single number people on a ketogenic diet or a
 * long fast actually watch, because either reading alone moves with the time
 * of day. mg/dL is how glucose is shown when that's what the meter says.
 */
import type { BloodReading, ReadingKind } from "./types";

/** Glucose's molar mass over ten: mmol/L × this = mg/dL. */
export const MGDL_PER_MMOL = 18.016;

export type GlucoseUnit = "mmol" | "mgdl";

export function isGlucoseUnit(v: unknown): v is GlucoseUnit {
  return v === "mmol" || v === "mgdl";
}

export function isReadingKind(v: unknown): v is ReadingKind {
  return v === "glucose" || v === "ketone";
}

export const READING_DEFS: Record<
  ReadingKind,
  { label: string; glyph: string; min: number; max: number }
> = {
  // 20–500 mg/dL on the meter.
  glucose: { label: "Glucose", glyph: "🩸", min: 1.1, max: 27.8 },
  ketone: { label: "Ketones", glyph: "🧪", min: 0, max: 8 },
};

/** Paired readings further apart than this aren't the same moment any more. */
const PAIR_WINDOW_MS = 30 * 60_000;

export function unitLabel(kind: ReadingKind, unit: GlucoseUnit): string {
  return kind === "glucose" && unit === "mgdl" ? "mg/dL" : "mmol/L";
}

/** A stored mmol/L value as a number in the unit it's shown in. */
export function toDisplay(kind: ReadingKind, mmol: number, unit: GlucoseUnit): number {
  if (kind === "glucose" && unit === "mgdl") return Math.round(mmol * MGDL_PER_MMOL);
  return Math.round(mmol * 10) / 10;
}

export function formatReading(
  kind: ReadingKind,
  mmol: number,
  unit: GlucoseUnit,
): string {
  const v = toDisplay(kind, mmol, unit);
  const shown = kind === "glucose" && unit === "mgdl" ? String(v) : v.toFixed(1);
  return `${shown} ${unitLabel(kind, unit)}`;
}

/**
 * What was typed, as mmol/L — or an error that says what's wrong with it.
 * The usual mistake is the other glucose unit, so that's what it suggests.
 */
export function parseReading(kind: ReadingKind, raw: string, unit: GlucoseUnit): number {
  const n = parseFloat(raw.trim().replace(",", "."));
  if (!isFinite(n)) throw new Error(`${READING_DEFS[kind].label}: give it a number.`);
  const mmol = kind === "glucose" && unit === "mgdl" ? n / MGDL_PER_MMOL : n;
  const { min, max, label } = READING_DEFS[kind];
  if (mmol < min || mmol > max) {
    if (kind === "glucose") {
      const other = unit === "mmol" ? n / MGDL_PER_MMOL : n * MGDL_PER_MMOL;
      if (other >= min && other <= max) {
        throw new Error(
          `${label} ${n} isn't possible in ${unitLabel(kind, unit)} — is your meter showing ${unitLabel(kind, unit === "mmol" ? "mgdl" : "mmol")}?`,
        );
      }
    }
    throw new Error(
      `${label} reads between ${formatReading(kind, min, unit)} and ${formatReading(kind, max, unit)}.`,
    );
  }
  return mmol;
}

/**
 * A glucose value from someone who didn't say which unit. The two ranges
 * barely overlap — 27.8 mmol/L is the meter's ceiling and 20 mg/dL its
 * floor — so anything above 30 is mg/dL.
 */
export function glucoseMmolFromEither(n: number): number {
  return n > 30 ? n / MGDL_PER_MMOL : n;
}

/** Where a ketone reading sits — the bands a ketogenic diet is read by. */
export function ketoneBand(mmol: number): string {
  if (mmol < 0.5) return "below ketosis";
  if (mmol < 1.5) return "light ketosis";
  if (mmol <= 3) return "deep ketosis";
  return "high";
}

/** Glucose (mmol/L) ÷ ketones (mmol/L); null when ketones read zero. */
export function gki(glucoseMmol: number, ketoneMmol: number): number | null {
  if (ketoneMmol <= 0) return null;
  return Math.round((glucoseMmol / ketoneMmol) * 10) / 10;
}

/** Glucose–ketone index bands, lowest first (lower = deeper ketosis). */
export function gkiBand(index: number): string {
  if (index < 1) return "very deep ketosis";
  if (index < 3) return "deep ketosis";
  if (index < 6) return "moderate ketosis";
  if (index < 9) return "light ketosis";
  return "not in ketosis";
}

/**
 * The reading of the other kind taken with this one — the nearest within
 * half an hour — so the pair can be read as one index. Strips go in one after
 * the other, so a few minutes apart is the normal case.
 */
export function partnerOf(r: BloodReading, all: BloodReading[]): BloodReading | null {
  const at = new Date(r.measured_at).getTime();
  let best: BloodReading | null = null;
  let bestGap = Infinity;
  for (const o of all) {
    if (o.kind === r.kind) continue;
    const gap = Math.abs(new Date(o.measured_at).getTime() - at);
    if (gap <= PAIR_WINDOW_MS && gap < bestGap) {
      best = o;
      bestGap = gap;
    }
  }
  return best;
}

/** The index for a reading and its partner, whichever way round they are. */
export function gkiOfPair(r: BloodReading, partner: BloodReading | null): number | null {
  if (!partner) return null;
  return r.kind === "glucose" ? gki(r.value, partner.value) : gki(partner.value, r.value);
}
