/** Normalize recorded minutes without guessing a workout's intensity. */
export function zone2Minutes(value: number | null | undefined, duration: number | null): number | null {
  if (value == null || !Number.isFinite(value) || value < 0) return null;
  return duration != null && Number.isFinite(duration) && duration >= 0
    ? Math.min(value, duration)
    : value;
}

export const DEFAULT_ZONE2_TARGET = 300;

export function exerciseProgress(workouts: { zone2_min: number | null; duration_min: number | null }[], target: number) {
  const minutes = workouts.reduce((sum, w) => sum + (zone2Minutes(w.zone2_min, w.duration_min) ?? 0), 0);
  return {
    minutes,
    remaining: Math.max(0, target - minutes),
    percent: Math.min(100, minutes / target * 100),
    unknown: workouts.filter((w) => w.zone2_min == null).length,
  };
}
