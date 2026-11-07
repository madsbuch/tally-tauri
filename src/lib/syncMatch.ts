// ---------------------------------------------------------------------------
// Same session, two sources. The watch's activities reach Tally twice — via
// Health Connect and straight from Garmin Connect — under ids that have
// nothing in common, so whichever arrives second has to recognise the first
// by when it happened. Both syncs use these rules, in both directions.
// ---------------------------------------------------------------------------

export interface Span {
  startMs: number;
  endMs: number;
}

/**
 * Both sources stamp the start from the same watch recording, so they agree
 * to the second in practice; minutes of slack absorb rounding and a session
 * trimmed in Garmin Connect after the fact.
 */
export const START_TOLERANCE_MS = 3 * 60_000;

function overlapMs(a: Span, b: Span): number {
  return Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs));
}

/**
 * Same workout: started within a few minutes of each other and, where both
 * have a length, sharing at least half of the shorter one. You can't do two
 * workouts at once, so that's unambiguous.
 */
export function sameSession(a: Span, b: Span): boolean {
  if (Math.abs(a.startMs - b.startMs) > START_TOLERANCE_MS) return false;
  const shorter = Math.min(a.endMs - a.startMs, b.endMs - b.startMs);
  // A session with no length recorded has only its start to go by.
  if (shorter <= 0) return true;
  return overlapMs(a, b) >= shorter / 2;
}

/** The candidate that is the same session as `target`, closest start first. */
export function bestSessionMatch<T extends Span>(target: Span, candidates: T[]): T | null {
  let best: T | null = null;
  for (const c of candidates) {
    if (!sameSession(target, c)) continue;
    if (best == null || Math.abs(c.startMs - target.startMs) < Math.abs(best.startMs - target.startMs)) {
      best = c;
    }
  }
  return best;
}

/**
 * Same night: the two recordings overlap by at least half of the shorter.
 * Start times don't have to agree — sources disagree about when you fell
 * asleep by far more than they do about a run.
 */
export function sameNight(a: Span, b: Span): boolean {
  const shorter = Math.min(a.endMs - a.startMs, b.endMs - b.startMs);
  if (shorter <= 0) return false;
  return overlapMs(a, b) >= shorter / 2;
}

/**
 * Whether a Health Connect record's `clientRecordId` names this Garmin
 * activity — the exact match, when Garmin puts its id in there. Matched as a
 * whole run of digits so 123 doesn't match 91234.
 */
export function recordIdNames(clientRecordId: string | null | undefined, activityId: string): boolean {
  if (!clientRecordId || !/^\d+$/.test(activityId)) return false;
  return new RegExp(`(^|\\D)${activityId}(\\D|$)`).test(clientRecordId);
}
