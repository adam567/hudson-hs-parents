-- Add max_non_parent_adult_age so the frontend can let the user tighten the
-- launching-window cutoff (default 22) without re-running a migration. The
-- server tier gate stays at 21-25 (broad); the client filters T2 rows where
-- max_non_parent_adult_age exceeds the chosen cutoff.
--
-- "Non-parent adult" = any voter aged 21+ outside the 42-63 parent band.
-- A household with no extras (T2c) has max_non_parent_adult_age IS NULL.

ALTER TABLE households
  ADD COLUMN IF NOT EXISTS max_non_parent_adult_age int;

WITH ages AS (
  SELECT v.address_key,
    EXTRACT(YEAR FROM CURRENT_DATE)::int - v.birth_year
      - CASE WHEN (EXTRACT(MONTH FROM CURRENT_DATE)::int, EXTRACT(DAY FROM CURRENT_DATE)::int) < (6,30) THEN 1 ELSE 0 END AS age
  FROM voter_records v
  WHERE v.birth_year IS NOT NULL AND v.address_key IS NOT NULL
),
agg AS (
  SELECT address_key,
    MAX(age) FILTER (WHERE age >= 21 AND NOT (age BETWEEN 42 AND 63))::int AS max_extra
  FROM ages
  GROUP BY address_key
)
UPDATE households h
   SET max_non_parent_adult_age = agg.max_extra
  FROM agg
 WHERE h.address_key = agg.address_key;

DROP VIEW IF EXISTS public.v_targets;
CREATE VIEW public.v_targets AS
SELECT
  id AS household_id,
  address_key,
  parcel_id,
  display_name,
  surname_key,
  owner_names,
  resident_names,
  owner_voter_surname_match,
  owner_voter_review,
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
  adult_21_25_count,
  adult_26plus_count,
  max_non_parent_adult_age,
  same_surname_youth_to_adult,
  senior_reg_date_min,
  tier,
  evidence_score,
  evidence_chips,
  why_sentence,
  institutional_owner,
  out_of_hudson_mailing,
  refreshed_at
FROM public.households h;

GRANT SELECT ON public.v_targets TO anon, authenticated;
