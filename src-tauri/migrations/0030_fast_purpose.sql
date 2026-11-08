ALTER TABLE `fasts` ADD `purpose` text;--> statement-breakpoint
-- A fast-safe note used to cover every entry with the same title; it now
-- covers its own entry only. Spread existing notes onto their namesakes so
-- past fasts read as they did.
UPDATE `food_entries` SET `fast_ok_note` = (
	SELECT fo.`fast_ok_note` FROM `food_entries` AS fo
	WHERE fo.`fast_ok_note` IS NOT NULL
		AND lower(trim(fo.`title`)) = lower(trim(`food_entries`.`title`))
	ORDER BY fo.`eaten_at` DESC LIMIT 1
) WHERE `fast_ok_note` IS NULL AND EXISTS (
	SELECT 1 FROM `food_entries` AS fo
	WHERE fo.`fast_ok_note` IS NOT NULL
		AND lower(trim(fo.`title`)) = lower(trim(`food_entries`.`title`))
);--> statement-breakpoint
-- The fixed 20 kcal threshold is gone (the diary agent judges each entry
-- now); entries logged under it keep not breaking a fast.
UPDATE `food_entries` SET `fast_ok_note` = 'Under 20 kcal'
WHERE `fast_ok_note` IS NULL
	AND json_extract(`nutrients`, '$.calories') IS NOT NULL
	AND json_extract(`nutrients`, '$.calories') < 20;
