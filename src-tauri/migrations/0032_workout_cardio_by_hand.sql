ALTER TABLE `workouts` ADD `cardio_by_hand` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Every cardio mark so far came from the switch (or the Zone 2 switch before
-- it): keep those as the user's. Workouts left off stay open to the Zone 2 rule.
UPDATE `workouts` SET `cardio_by_hand` = 1 WHERE `cardio` = 1;
