ALTER TABLE `fasts` ADD `start_day` text;--> statement-breakpoint
ALTER TABLE `fasts` ADD `end_day` text;--> statement-breakpoint
ALTER TABLE `fasts` ADD `tz_offset_min` integer;--> statement-breakpoint
ALTER TABLE `food_entries` ADD `day` text;--> statement-breakpoint
ALTER TABLE `food_entries` ADD `tz_offset_min` integer;--> statement-breakpoint
CREATE INDEX `idx_food_entries_day` ON `food_entries` (`day`);--> statement-breakpoint
ALTER TABLE `sleep_sessions` ADD `day` text;--> statement-breakpoint
ALTER TABLE `sleep_sessions` ADD `tz_offset_min` integer;--> statement-breakpoint
CREATE INDEX `idx_sleep_sessions_day` ON `sleep_sessions` (`day`);--> statement-breakpoint
ALTER TABLE `supplement_logs` ADD `day` text;--> statement-breakpoint
ALTER TABLE `supplement_logs` ADD `tz_offset_min` integer;--> statement-breakpoint
CREATE INDEX `idx_supplement_logs_day` ON `supplement_logs` (`day`);--> statement-breakpoint
ALTER TABLE `workouts` ADD `day` text;--> statement-breakpoint
ALTER TABLE `workouts` ADD `tz_offset_min` integer;--> statement-breakpoint
CREATE INDEX `idx_workouts_day` ON `workouts` (`day`);
--> statement-breakpoint
-- Backfill: every row so far was logged in Denmark, so its instants are read
-- as Europe/Copenhagen — CEST (UTC+2) in summer, CET (UTC+1) in winter — and
-- not in whatever zone the phone happens to be in when this migration runs.
-- Getting this wrong by an hour only moves a day boundary for things logged
-- between 22:00 and 01:00, but those are exactly the late dinners that make a
-- day's calories add up.
UPDATE food_entries SET tz_offset_min = CASE
    WHEN julianday(eaten_at) >= julianday(date(strftime('%Y', eaten_at) || '-04-01', 'weekday 0', '-7 days'), '+1 hour')
      AND julianday(eaten_at) < julianday(date(strftime('%Y', eaten_at) || '-11-01', 'weekday 0', '-7 days'), '+1 hour')
    THEN 120 ELSE 60 END
  WHERE day IS NULL;--> statement-breakpoint
UPDATE food_entries SET day = date(eaten_at, tz_offset_min || ' minutes')
  WHERE day IS NULL;--> statement-breakpoint

UPDATE workouts SET tz_offset_min = CASE
    WHEN julianday(performed_at) >= julianday(date(strftime('%Y', performed_at) || '-04-01', 'weekday 0', '-7 days'), '+1 hour')
      AND julianday(performed_at) < julianday(date(strftime('%Y', performed_at) || '-11-01', 'weekday 0', '-7 days'), '+1 hour')
    THEN 120 ELSE 60 END
  WHERE day IS NULL;--> statement-breakpoint
UPDATE workouts SET day = date(performed_at, tz_offset_min || ' minutes')
  WHERE day IS NULL;--> statement-breakpoint

UPDATE supplement_logs SET tz_offset_min = CASE
    WHEN julianday(taken_at) >= julianday(date(strftime('%Y', taken_at) || '-04-01', 'weekday 0', '-7 days'), '+1 hour')
      AND julianday(taken_at) < julianday(date(strftime('%Y', taken_at) || '-11-01', 'weekday 0', '-7 days'), '+1 hour')
    THEN 120 ELSE 60 END
  WHERE day IS NULL;--> statement-breakpoint
UPDATE supplement_logs SET day = date(taken_at, tz_offset_min || ' minutes')
  WHERE day IS NULL;--> statement-breakpoint

-- A night belongs to the morning it ended on.
UPDATE sleep_sessions SET tz_offset_min = CASE
    WHEN julianday(ended_at) >= julianday(date(strftime('%Y', ended_at) || '-04-01', 'weekday 0', '-7 days'), '+1 hour')
      AND julianday(ended_at) < julianday(date(strftime('%Y', ended_at) || '-11-01', 'weekday 0', '-7 days'), '+1 hour')
    THEN 120 ELSE 60 END
  WHERE day IS NULL;--> statement-breakpoint
UPDATE sleep_sessions SET day = date(ended_at, tz_offset_min || ' minutes')
  WHERE day IS NULL;--> statement-breakpoint

-- A fast spans days; both ends are stamped, and end_day stays null while it runs.
UPDATE fasts SET tz_offset_min = CASE
    WHEN julianday(started_at) >= julianday(date(strftime('%Y', started_at) || '-04-01', 'weekday 0', '-7 days'), '+1 hour')
      AND julianday(started_at) < julianday(date(strftime('%Y', started_at) || '-11-01', 'weekday 0', '-7 days'), '+1 hour')
    THEN 120 ELSE 60 END
  WHERE start_day IS NULL;--> statement-breakpoint
UPDATE fasts SET start_day = date(started_at, tz_offset_min || ' minutes')
  WHERE start_day IS NULL;--> statement-breakpoint
UPDATE fasts SET end_day = date(ended_at, (CASE
    WHEN julianday(ended_at) >= julianday(date(strftime('%Y', ended_at) || '-04-01', 'weekday 0', '-7 days'), '+1 hour')
      AND julianday(ended_at) < julianday(date(strftime('%Y', ended_at) || '-11-01', 'weekday 0', '-7 days'), '+1 hour')
    THEN 120 ELSE 60 END) || ' minutes')
  WHERE ended_at IS NOT NULL AND end_day IS NULL;
--> statement-breakpoint

-- Last resort. A row can only still be unstamped if its timestamp wasn't a
-- date SQLite could read, and an unstamped row is invisible to every query
-- below — so fall back to the date the string starts with rather than let
-- anything drop out of the diary.
UPDATE food_entries SET day = substr(eaten_at, 1, 10) WHERE day IS NULL;--> statement-breakpoint
UPDATE workouts SET day = substr(performed_at, 1, 10) WHERE day IS NULL;--> statement-breakpoint
UPDATE supplement_logs SET day = substr(taken_at, 1, 10) WHERE day IS NULL;--> statement-breakpoint
UPDATE sleep_sessions SET day = substr(ended_at, 1, 10) WHERE day IS NULL;--> statement-breakpoint
UPDATE fasts SET start_day = substr(started_at, 1, 10) WHERE start_day IS NULL;--> statement-breakpoint
UPDATE fasts SET end_day = substr(ended_at, 1, 10) WHERE ended_at IS NOT NULL AND end_day IS NULL;
