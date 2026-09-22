/**
 * Which day a thing happened on, decided where it happened.
 *
 * Every timestamp in the diary is a UTC instant, which is unambiguous but
 * doesn't say what day it was — that depends on where you were standing. The
 * app used to answer by re-reading old instants in the phone's *current*
 * timezone, so flying to another one silently moved history: a late dinner in
 * Copenhagen became the day before once the phone was on New York time, and
 * with it the day's calories, the streak, and what the coach saw.
 *
 * So the day is stamped when the row is written, along with the offset it was
 * written at, and never recomputed. A meal eaten at 19:00 in Denmark stays a
 * 19:00 meal on that Danish day, read from anywhere on earth.
 *
 * The functions below take an optional offset: pass the stored one for
 * something that already happened, leave it out for something happening now
 * (which is here, wherever here is).
 */

/** Minutes east of UTC the device is at that instant (−60 = UTC−01:00). */
export function offsetMinOf(at: Date = new Date()): number {
  return -at.getTimezoneOffset();
}

/** The offset to read an instant in: the stored one, or the device's own. */
function resolve(iso: string, offsetMin?: number | null): number {
  return offsetMin ?? offsetMinOf(new Date(iso));
}

/** Local day ("YYYY-MM-DD") of an instant, in `offsetMin` or here. */
export function dayOf(iso: string, offsetMin?: number | null): string {
  const shifted = new Date(new Date(iso).getTime() + resolve(iso, offsetMin) * 60_000);
  return shifted.toISOString().slice(0, 10);
}

/** Wall-clock "HH:MM" of an instant, in `offsetMin` or here. */
export function timeOf(iso: string, offsetMin?: number | null): string {
  const shifted = new Date(new Date(iso).getTime() + resolve(iso, offsetMin) * 60_000);
  return shifted.toISOString().slice(11, 16);
}

/**
 * The stamp for something happening now (or a moment being logged from here):
 * the day and the offset, from the same instant.
 */
export function stampOf(iso: string): { day: string; tz_offset_min: number } {
  const at = new Date(iso);
  const tz_offset_min = offsetMinOf(at);
  return { day: dayOf(iso, tz_offset_min), tz_offset_min };
}

/**
 * The instant for a local day and "HH:MM" read in `offsetMin` — the inverse of
 * `dayOf`/`timeOf`, so editing the time of an entry logged elsewhere keeps it
 * where it was rather than dragging it into the current timezone.
 */
export function isoFromLocal(day: string, hhmm: string, offsetMin?: number | null): string {
  const [h = 0, min = 0] = hhmm.split(":").map(Number);
  if (offsetMin == null) {
    const [y = 0, mo = 1, d = 1] = day.split("-").map(Number);
    return new Date(y, mo - 1, d, h, min).toISOString();
  }
  const asUtc = new Date(`${day}T${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}:00Z`);
  return new Date(asUtc.getTime() - offsetMin * 60_000).toISOString();
}

/**
 * The time as the clock showed it where it happened, in the phone's own
 * format (12h or 24h). The instant is shifted into the stored offset and then
 * rendered as UTC, which is the only way to format a wall clock the device
 * isn't currently set to.
 */
export function formatTime(iso: string, offsetMin?: number | null): string {
  const shifted = new Date(new Date(iso).getTime() + resolve(iso, offsetMin) * 60_000);
  return shifted.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
}

/**
 * The time, plus the zone it was logged in when that isn't the one the phone
 * is in now: "19:30" at home, "19:30 (UTC+2)" once you've flown somewhere.
 */
export function formatTimeHere(iso: string, offsetMin: number | null): string {
  const t = formatTime(iso, offsetMin);
  if (offsetMin == null || !isElsewhere(offsetMin)) return t;
  return `${t} (${shortOffsetLabel(offsetMin)})`;
}

/** "UTC+2" / "UTC-7:30" — the compact form, for sitting next to a time. */
function shortOffsetLabel(offsetMin: number): string {
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `UTC${sign}${h}${m ? `:${String(m).padStart(2, "0")}` : ""}`;
}

/** "UTC+02:00" / "UTC-07:00", for telling the model where the user is. */
export function offsetLabel(offsetMin: number): string {
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

/**
 * True when an entry was logged somewhere other than where the phone is now —
 * the cue to show its timezone next to its time instead of quietly implying
 * the current one.
 */
export function isElsewhere(offsetMin: number | null): boolean {
  return offsetMin != null && offsetMin !== offsetMinOf();
}
