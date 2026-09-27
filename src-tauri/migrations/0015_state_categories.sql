CREATE TABLE `state_categories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`label` text NOT NULL,
	`icon` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_state_categories_label` ON `state_categories` (`label`);--> statement-breakpoint

-- The three to start from. Everything else is added by the person using it.
INSERT INTO state_categories (label, icon, created_at)
  VALUES ('Bloated', '🫧', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));--> statement-breakpoint
INSERT INTO state_categories (label, icon, created_at)
  VALUES ('Depressive thoughts', '🌧️', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));--> statement-breakpoint
INSERT INTO state_categories (label, icon, created_at)
  VALUES ('Anxious', '😰', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));--> statement-breakpoint

-- Rows logged against the old built-in list stored an icon KEY. Icons are the
-- emoji themselves now, so the keys are translated in place rather than left
-- to degrade to 💭 — a state already logged should keep the face it had.
UPDATE state_logs SET icon = CASE icon
    WHEN 'low_mood' THEN '🌧️'
    WHEN 'anxious' THEN '😰'
    WHEN 'stressed' THEN '😣'
    WHEN 'irritable' THEN '😤'
    WHEN 'brain_fog' THEN '🌫️'
    WHEN 'bloated' THEN '🫧'
    WHEN 'stomach_ache' THEN '😖'
    WHEN 'nauseous' THEN '🤢'
    WHEN 'heartburn' THEN '🔥'
    WHEN 'headache' THEN '🤕'
    WHEN 'tired' THEN '🥱'
    WHEN 'cravings' THEN '🍫'
    WHEN 'energetic' THEN '⚡'
    WHEN 'calm' THEN '🌿'
    WHEN 'good_mood' THEN '🙂'
    ELSE NULL
  END
  WHERE icon IS NOT NULL;
