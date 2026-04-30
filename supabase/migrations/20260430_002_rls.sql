-- Row-Level Security: per-user on every user-owned table.
-- Reference data (parcels, voter_records, datazapp_imports, households,
-- walking_clusters, walking_cluster_members) is read-only for any
-- authenticated user; writes happen via the service role from cron jobs.

alter table parcels enable row level security;
alter table voter_records enable row level security;
alter table datazapp_imports enable row level security;
alter table households enable row level security;
alter table walking_clusters enable row level security;
alter table walking_cluster_members enable row level security;

alter table campaigns enable row level security;
alter table campaign_household_state enable row level security;
alter table knock_events enable row level security;
alter table user_preferences enable row level security;
alter table saved_filter_recipes enable row level security;
alter table saved_areas enable row level security;

-- Reference tables: any authenticated user can read.
drop policy if exists parcels_read on parcels;
create policy parcels_read on parcels for select to authenticated using (true);

drop policy if exists voter_read on voter_records;
create policy voter_read on voter_records for select to authenticated using (true);

drop policy if exists datazapp_read on datazapp_imports;
create policy datazapp_read on datazapp_imports for select to authenticated using (true);

drop policy if exists households_read on households;
create policy households_read on households for select to authenticated using (true);

drop policy if exists clusters_read on walking_clusters;
create policy clusters_read on walking_clusters for select to authenticated using (true);

drop policy if exists cluster_members_read on walking_cluster_members;
create policy cluster_members_read on walking_cluster_members for select to authenticated using (true);

-- User-owned tables: users can only see/edit their own rows.
drop policy if exists campaigns_self on campaigns;
create policy campaigns_self on campaigns
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists chs_self on campaign_household_state;
create policy chs_self on campaign_household_state
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists knock_events_self on knock_events;
create policy knock_events_self on knock_events
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists prefs_self on user_preferences;
create policy prefs_self on user_preferences
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists recipes_self on saved_filter_recipes;
create policy recipes_self on saved_filter_recipes
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists areas_self on saved_areas;
create policy areas_self on saved_areas
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Auto-create a user_preferences row for every new auth.users row.
create or replace function ensure_user_preferences() returns trigger as $$
begin
  insert into user_preferences (user_id) values (new.id) on conflict do nothing;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists trg_ensure_prefs on auth.users;
create trigger trg_ensure_prefs after insert on auth.users
  for each row execute function ensure_user_preferences();
