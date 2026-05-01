-- Add owner_voter_surname_match to the targets view so the modal can use it.
DROP VIEW IF EXISTS public.v_targets;
CREATE VIEW public.v_targets AS
SELECT
  id AS household_id,
  address_key,
  parcel_id,
  display_name,
  surname_key,
  owner_names,
  owner_voter_surname_match,
  situs_address,
  situs_city,
  situs_zip,
  lat,
  lng,
  market_value,
  sqft,
  year_built,
  years_owned,
  mailing_same_as_situs,
  parcel_owner_occupied_local,
  voter_count,
  has_17_18_voter,
  count_17_18_voters,
  has_19_20_voter,
  count_19_20_voters,
  adult_count,
  adult_42_63_count,
  adult_45_58_count,
  same_surname_youth_to_adult,
  senior_reg_date_min,
  datazapp_hit,
  datazapp_match_count,
  tier,
  evidence_score,
  evidence_chips,
  why_sentence,
  institutional_owner,
  out_of_hudson_mailing,
  refreshed_at
FROM public.households h;

GRANT SELECT ON public.v_targets TO anon, authenticated;
