-- Address advisor findings from initial migrations.

-- 1. Views: switch to security_invoker so they respect querying user's RLS.
alter view v_targets set (security_invoker = true);
alter view v_active_campaign_state set (security_invoker = true);

-- 2. Functions: pin search_path to prevent role-mutable-search-path lint.
alter function set_updated_at() set search_path = '';
alter function ensure_user_preferences() set search_path = 'public, pg_catalog';
alter function recompute_tiers(date) set search_path = 'public, pg_catalog';
alter function mark_knocked(uuid, text, text, int) set search_path = 'public, pg_catalog';
alter function reset_knock(uuid) set search_path = 'public, pg_catalog';

-- 3. Lock down ensure_user_preferences so only the auth.users trigger fires it.
revoke execute on function ensure_user_preferences() from public, anon, authenticated;

-- 4. Wrap auth.uid() in (select ...) on RLS policies for plan caching.
drop policy if exists campaigns_self on campaigns;
create policy campaigns_self on campaigns
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists chs_self on campaign_household_state;
create policy chs_self on campaign_household_state
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists knock_events_self on knock_events;
create policy knock_events_self on knock_events
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists prefs_self on user_preferences;
create policy prefs_self on user_preferences
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists recipes_self on saved_filter_recipes;
create policy recipes_self on saved_filter_recipes
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists areas_self on saved_areas;
create policy areas_self on saved_areas
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- 5. Cover the three flagged foreign keys with indexes.
create index if not exists idx_households_parcel_id on households(parcel_id);
create index if not exists idx_user_preferences_default_campaign on user_preferences(default_campaign_id);
create index if not exists idx_walking_cluster_members_household on walking_cluster_members(household_id);
