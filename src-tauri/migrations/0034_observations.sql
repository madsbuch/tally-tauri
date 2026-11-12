-- Rules for living are retired: the things they were for are logged as
-- observations now. Nothing written down is lost on the way out — every time
-- a rule came up becomes an observation at that moment, with the rule in
-- their words and whatever was noted about it in the note.
INSERT INTO state_logs (logged_at, label, icon, note, day, tz_offset_min)
  SELECT
    l.logged_at,
    'Rule for living',
    '🧭',
    '"' || l.rule_text || '"'
      || COALESCE(char(10) || NULLIF(trim(l.situation), ''), '')
      || COALESCE(char(10) || 'Believed it ' || l.belief || '%', '')
      || COALESCE(char(10) || CASE l.acted_on
           WHEN 'yes' THEN 'Followed it'
           WHEN 'partly' THEN 'Partly followed it'
           WHEN 'no' THEN 'Didn''t follow it'
         END, ''),
    l.day,
    l.tz_offset_min
  FROM life_rule_logs l;
--> statement-breakpoint
-- A rule they wrote down but never logged coming up is still theirs: it lands
-- on the day it was written down. Suggestions they never confirmed were the
-- diary's guess, not their words, so those go.
INSERT INTO state_logs (logged_at, label, icon, note, day, tz_offset_min)
  SELECT
    r.created_at,
    'Rule for living',
    '🧭',
    '"' || r.text || '"'
      || COALESCE(char(10) || 'Instead: ' || NULLIF(trim(r.alternative), ''), ''),
    r.day,
    r.tz_offset_min
  FROM life_rules r
  WHERE r.status != 'suggested'
    AND NOT EXISTS (SELECT 1 FROM life_rule_logs l WHERE l.rule_id = r.id);
--> statement-breakpoint
DROP TABLE `life_rule_logs`;--> statement-breakpoint
DROP TABLE `life_rules`;
