-- Stale default ['T1','T2','T3'] reflected the old taxonomy where T3 was
-- "likely senior" rather than "recent grad — adjacent". Update to the new
-- priority order: confirmed + list-match + list-match+voter visible by default,
-- two-adult inference and list-match-only opted in, recent grad off-thesis.
ALTER TABLE user_preferences
  ALTER COLUMN default_visible_tiers
  SET DEFAULT '["T1","T2","T4"]'::jsonb;
