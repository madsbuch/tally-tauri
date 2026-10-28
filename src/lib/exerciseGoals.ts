/** Normalize recorded minutes without guessing a workout's intensity. */
export function zone2Minutes(value: number | null | undefined, duration: number | null): number | null {
  if (value == null || !Number.isFinite(value) || value < 0) return null;
  return duration != null && Number.isFinite(duration) && duration >= 0
    ? Math.min(value, duration)
    : value;
}

export const DEFAULT_ZONE2_TARGET = 300;

export function exerciseProgress(workouts: DiaryWorkout[], target: number) {
  const values = workouts.map(diaryZone2Minutes);
  const minutes = values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  return {
    minutes,
    remaining: Math.max(0, target - minutes),
    percent: Math.min(100, minutes / target * 100),
    unknown: values.filter((value) => value == null).length,
  };
}

/** The 24-day view uses four weekly targets, as configured for Summary. */
export function exerciseTarget(weeklyTarget: number, days: number): number {
  return weeklyTarget * (days === 24 ? 4 : days / 7);
}

type DiaryWorkout = {
  zone2_min: number | null;
  duration_min: number | null;
  title?: string;
  description?: string | null;
};

/**
 * Older diary entries already describe Zone 2 even though they predate the
 * structured field. Read that evidence at display time, so edits/deletions
 * immediately affect totals and no duplicate log or backfill is needed.
 * Activity type and average HR alone don't establish time in a heart-rate zone.
 */
export function diaryZone2Minutes(workout: DiaryWorkout): number | null {
  if (workout.zone2_min != null) return zone2Minutes(workout.zone2_min, workout.duration_min);
  const text = `${workout.title ?? ""}. ${workout.description ?? ""}`.toLowerCase()
    .replace(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\s*(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|m)\b/g,
      (_, hours: string, minutes: string) => `${Number(hours) * 60 + Number(minutes)} min`);
  const zone = String.raw`\b(?:zone[\s-]*(?:2|two)|z\s*2)\b`;
  if (!new RegExp(zone).test(text)) return null;
  // Don't turn a goal, a negation, or an uncertain zone into completed exercise.
  if (new RegExp(String.raw`\b(?:no|not|without|outside|above|below)\s+${zone}`).test(text) ||
      /\b(?:goal|target|planned|aim|unsure|unknown|maybe|possibly|not)\b/.test(text)) return null;

  const percent = text.match(new RegExp(`${zone}\\s*[:=(–-]?\\s*(\\d+(?:\\.\\d+)?)\\s*%`))
    ?? text.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*%\\s*(?:of (?:the )?(?:time|session) )?(?:in\\s+)?${zone}`));
  if (percent) {
    const fraction = Number(percent[1]) / 100;
    return workout.duration_min != null && fraction <= 1
      ? zone2Minutes(workout.duration_min * fraction, workout.duration_min)
      : null;
  }
  const amount = String.raw`(\d+(?:\.\d+)?)\s*(minutes?|mins?|m|hours?|hrs?|h)\b`;
  const after = text.match(new RegExp(`${zone}\\s*(?:time\\s*)?[:=(–-]?\\s*(?:for\\s+)?${amount}`));
  const before = text.match(new RegExp(`${amount}\\s*(?:of\\s+|in\\s+|at\\s+)?${zone}`));
  const match = after ?? before;
  if (match) {
    const value = Number(match[1]) * (match[2]?.startsWith("h") ? 60 : 1);
    return zone2Minutes(value, workout.duration_min);
  }
  const clock = text.match(new RegExp(`${zone}\\s*[:=(–-]?\\s*(\\d+):(\\d{2})(?::(\\d{2}))?\\b`));
  if (clock) {
    const value = clock[3] == null
      ? Number(clock[1]) + Number(clock[2]) / 60
      : Number(clock[1]) * 60 + Number(clock[2]) + Number(clock[3]) / 60;
    return zone2Minutes(value, workout.duration_min);
  }
  // A session labelled Zone 2 contributes its duration. Mixed-zone sessions
  // need a breakdown; counting all of their time would inflate the goal.
  if (/\b(?:zone[\s-]*[1345]|z\s*[1345]|intervals?|mixed|partly|partially|mostly|some|warm[ -]?up|cool[ -]?down)\b/.test(text)) return null;
  return zone2Minutes(workout.duration_min, workout.duration_min);
}
