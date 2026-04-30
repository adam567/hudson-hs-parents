-- Migration 005 quoted the search_path list, which Postgres parsed as a single
-- schema named "public, pg_catalog" (doesn't exist). That broke the
-- ensure_user_preferences trigger on auth.users — first sign-up failed with
-- "Database error saving new user". Fix by passing the schemas as a
-- comma-separated identifier list, with pg_catalog first per the security
-- linter's recommendation.

alter function ensure_user_preferences() reset search_path;
alter function ensure_user_preferences() set search_path = pg_catalog, public;

alter function recompute_tiers(date) reset search_path;
alter function recompute_tiers(date) set search_path = pg_catalog, public;

alter function mark_knocked(uuid, text, text, int) reset search_path;
alter function mark_knocked(uuid, text, text, int) set search_path = pg_catalog, public;

alter function reset_knock(uuid) reset search_path;
alter function reset_knock(uuid) set search_path = pg_catalog, public;

alter function set_updated_at() reset search_path;
alter function set_updated_at() set search_path = pg_catalog;
