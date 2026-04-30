-- Hudson HS Parents — schema. Single-user app. RLS by user_id.

create extension if not exists pg_trgm;
create extension if not exists "uuid-ossp";

-- ── Reference: parcel data we ingest from Summit County ───────────────────
create table if not exists parcels (
  id uuid primary key default gen_random_uuid(),
  county_parcel_id text not null unique,
  address_key text not null,            -- canonical join key
  situs_address text,
  situs_city text,
  situs_zip text,
  mailing_address text,
  mailing_city text,
  mailing_zip text,
  mailing_same_as_situs boolean,
  sqft integer,
  market_value numeric,
  year_built integer,
  property_class text,
  owner1_raw text,
  owner2_raw text,
  lat double precision,
  lng double precision,
  source_payload jsonb,
  refreshed_at timestamptz not null default now()
);
create index if not exists idx_parcels_address_key on parcels(address_key);
create index if not exists idx_parcels_zip on parcels(situs_zip);
create index if not exists idx_parcels_value on parcels(market_value desc nulls last);
create index if not exists idx_parcels_owner1_trgm on parcels using gin (owner1_raw gin_trgm_ops);

-- ── Voter records (Ohio SOS, address-keyed) ───────────────────────────────
create table if not exists voter_records (
  id uuid primary key default gen_random_uuid(),
  county_id text,
  sos_id text unique,
  first_name text,
  last_name text,
  middle_name text,
  birth_year integer,
  reg_date date,
  voter_status text,
  party text,
  precinct text,
  res_address text,
  res_city text,
  res_zip text,
  address_key text not null,
  mailing_address text,
  mailing_city text,
  mailing_state text,
  mailing_zip text,
  refreshed_at timestamptz not null default now()
);
create index if not exists idx_voter_address_key on voter_records(address_key);
create index if not exists idx_voter_birth_year on voter_records(birth_year);
create index if not exists idx_voter_reg_date on voter_records(reg_date desc);
create index if not exists idx_voter_lastname on voter_records(last_name);

-- ── Datazapp staging ──────────────────────────────────────────────────────
create table if not exists datazapp_imports (
  id uuid primary key default gen_random_uuid(),
  batch_label text not null,
  first_name text,
  last_name text,
  address text,
  address2 text,
  city text,
  state text,
  zip text,
  zip4 text,
  gender text,
  address_key text not null,
  imported_at timestamptz not null default now()
);
create index if not exists idx_datazapp_address_key on datazapp_imports(address_key);
create index if not exists idx_datazapp_batch on datazapp_imports(batch_label);

-- ── Household spine (rolled-up by address_key) ────────────────────────────
create table if not exists households (
  id uuid primary key default gen_random_uuid(),
  address_key text not null unique,
  parcel_id uuid references parcels(id) on delete set null,

  -- Display
  display_name text,
  surname_key text,
  owner_names text[] default '{}',
  situs_address text,
  situs_city text,
  situs_zip text,
  lat double precision,
  lng double precision,

  -- Property facts
  market_value numeric,
  sqft integer,
  year_built integer,
  years_owned integer,
  mailing_same_as_situs boolean,
  parcel_owner_occupied_local boolean,

  -- Voter rollup (computed at refresh time)
  voter_count integer default 0,
  has_17_18_voter boolean default false,
  count_17_18_voters integer default 0,
  has_19_20_voter boolean default false,
  count_19_20_voters integer default 0,
  youngest_voter_birth_year integer,
  oldest_voter_birth_year integer,
  adult_42_63_count integer default 0,
  adult_45_58_count integer default 0,
  adult_count integer default 0,
  same_surname_youth_to_adult boolean default false,
  senior_reg_date_min date,

  -- Datazapp overlay
  datazapp_hit boolean default false,
  datazapp_match_count integer default 0,

  -- Tier + score (recomputed by recompute_tiers RPC)
  tier text check (tier in ('T1','T2','T3','T4','T5','TX')),
  evidence_score integer default 0,
  evidence_chips jsonb default '[]'::jsonb,
  why_sentence text,

  -- Suppression flags
  institutional_owner boolean default false,
  out_of_hudson_mailing boolean default false,

  refreshed_at timestamptz not null default now()
);
create index if not exists idx_households_tier on households(tier);
create index if not exists idx_households_evidence on households(evidence_score desc);
create index if not exists idx_households_market_value on households(market_value desc nulls last);
create index if not exists idx_households_zip on households(situs_zip);
create index if not exists idx_households_surname_trgm on households using gin (surname_key gin_trgm_ops);
create index if not exists idx_households_address_key on households(address_key);

-- ── Campaigns ─────────────────────────────────────────────────────────────
create table if not exists campaigns (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  name text not null,
  season_type text not null check (season_type in ('spring','fall','custom')),
  anchor_date date not null,
  school_year_label text,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  is_active boolean not null default true,
  notes text default '',
  unique (user_id, name)
);
create index if not exists idx_campaigns_user_active on campaigns(user_id, is_active);

-- ── Per-campaign household state ──────────────────────────────────────────
create table if not exists campaign_household_state (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  campaign_id uuid not null references campaigns(id) on delete cascade,
  household_id uuid not null references households(id) on delete cascade,
  status text not null default 'ready' check (status in ('ready','knocked','skipped','converted')),
  cooldown_until date,
  follow_up_requested boolean default false,
  last_outcome text,                    -- 'no_answer','talked','follow_up','skip'
  last_note text,
  last_action_at timestamptz,
  unique (campaign_id, household_id)
);
create index if not exists idx_chs_campaign on campaign_household_state(campaign_id);
create index if not exists idx_chs_household on campaign_household_state(household_id);
create index if not exists idx_chs_user on campaign_household_state(user_id);

-- ── Append-only knock event log ───────────────────────────────────────────
create table if not exists knock_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  campaign_id uuid not null references campaigns(id) on delete cascade,
  household_id uuid not null references households(id) on delete cascade,
  occurred_at timestamptz not null default now(),
  outcome text not null check (outcome in ('no_answer','talked','follow_up','skip','knocked')),
  note text default '',
  cooldown_days_override integer
);
create index if not exists idx_knock_events_campaign on knock_events(campaign_id, occurred_at desc);
create index if not exists idx_knock_events_household on knock_events(household_id, occurred_at desc);
create index if not exists idx_knock_events_user on knock_events(user_id);

-- ── User preferences (one row per user) ───────────────────────────────────
create table if not exists user_preferences (
  user_id uuid primary key references auth.users on delete cascade,
  default_campaign_id uuid references campaigns(id) on delete set null,
  default_map_center_lat double precision default 41.2406,
  default_map_center_lng double precision default -81.4407,
  default_map_zoom integer default 13,
  default_basemap text default 'light' check (default_basemap in ('light','street','satellite')),
  default_visible_tiers jsonb default '["T1","T2","T3"]'::jsonb,
  default_visible_cohorts jsonb default '[]'::jsonb,
  default_show_knocked_mode text default 'hide' check (default_show_knocked_mode in ('hide','show','only')),
  default_cooldown_days integer default 30,
  default_cluster_target_size integer default 22,
  default_heatmap_on boolean default false,
  default_satellite_on boolean default false,
  email_cadence text default 'off' check (email_cadence in ('off','on_demand','daily','weekdays','weekly_monday')),
  email_send_hour_local integer default 7,
  email_on_demand_only boolean default true,
  default_export_format text default 'plain_csv',
  default_avery_template text default '5160',
  saved_home_view jsonb default '{}'::jsonb,
  last_seen_at timestamptz,
  updated_at timestamptz not null default now()
);

-- ── Saved filter recipes ──────────────────────────────────────────────────
create table if not exists saved_filter_recipes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  name text not null,
  description text default '',
  filter_state jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, name)
);
create index if not exists idx_recipes_user on saved_filter_recipes(user_id);

-- ── Saved areas (drawn polygons / named neighborhoods) ────────────────────
create table if not exists saved_areas (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  name text not null,
  geometry_geojson jsonb not null,         -- GeoJSON Polygon
  pinned boolean default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, name)
);
create index if not exists idx_areas_user on saved_areas(user_id);

-- ── Walking-cluster suggestions (precomputed nightly, on-demand for UI) ──
create table if not exists walking_clusters (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references campaigns(id) on delete cascade,
  cluster_seq integer not null,
  cluster_label text,
  center_lat double precision,
  center_lng double precision,
  hull_geojson jsonb,
  household_count integer not null default 0,
  signal_density numeric default 0,
  computed_at timestamptz not null default now(),
  unique (campaign_id, cluster_seq)
);
create index if not exists idx_clusters_campaign on walking_clusters(campaign_id);

create table if not exists walking_cluster_members (
  cluster_id uuid not null references walking_clusters(id) on delete cascade,
  household_id uuid not null references households(id) on delete cascade,
  route_order integer,
  primary key (cluster_id, household_id)
);

-- ── Updated-at trigger ───────────────────────────────────────────────────
create or replace function set_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

drop trigger if exists trg_recipes_updated on saved_filter_recipes;
create trigger trg_recipes_updated before update on saved_filter_recipes
  for each row execute function set_updated_at();

drop trigger if exists trg_areas_updated on saved_areas;
create trigger trg_areas_updated before update on saved_areas
  for each row execute function set_updated_at();

drop trigger if exists trg_prefs_updated on user_preferences;
create trigger trg_prefs_updated before update on user_preferences
  for each row execute function set_updated_at();
