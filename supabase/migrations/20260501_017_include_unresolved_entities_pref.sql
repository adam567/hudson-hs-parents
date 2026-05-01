-- Persist the agent's preference for surfacing entity-owned households that
-- couldn't be resolved to a natural person via voter records. Default false:
-- "South Family Revocable Trust" with no voters at the address stays off the
-- map until she explicitly opts in (extra research needed before knocking).
ALTER TABLE public.user_preferences
  ADD COLUMN IF NOT EXISTS include_unresolved_entities boolean NOT NULL DEFAULT false;
