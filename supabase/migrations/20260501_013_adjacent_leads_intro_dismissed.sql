-- Track when the user dismissed the first-run "Adjacent leads" intro banner.
-- Mirrors the last_seen_at pattern: nullable timestamptz, stamped once on
-- first interaction. NULL = not yet dismissed (banner shown).
ALTER TABLE user_preferences
  ADD COLUMN IF NOT EXISTS adjacent_leads_intro_dismissed_at timestamptz;
