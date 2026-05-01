-- Drop Datazapp end-to-end + consolidate the senior-household tier on
-- voter-pattern alone.
--
-- Why: spring-2026 Datazapp file was a 4x over-supply (1,635 records in one
-- ZIP vs ~400-450 realistic senior households across all Hudson schools);
-- vendor acknowledged a bad export and refunded. Two independent peer reviews
-- (Gemini, Codex) reached the same call: Datazapp was buying false-precision
-- narrative, not real precision -- the prior T2 (DZ + 2 adults + 8 yrs tenure)
-- was actually a *looser* gate than T2b (voter-pattern only) because it
-- skipped owner-occupancy, institutional-owner, and 19/20-voter exclusions.
--
-- Effect on tiers:
--   T1 unchanged (voter-confirmed senior at address).
--   T2 absorbs the prior T2b's strict gate -- 2 parent-age adults, 8+ years
--     owned, owner-occupied, non-institutional, no 19/20-voter at address --
--     and additionally rejects rows the new owner_voter_review pass classified
--     as absentee_or_rental.
--   T3 unchanged (recent-grad voter, off-thesis adjacent lead).
--   T4 and T5 dropped.
--
-- Adds: households.owner_voter_review for the one-time hand-classification of
-- the ~343 owner/voter surname mismatches via the dev-only review tool.
-- Classifications fold back into scoring: owner_lives_here / trust_or_llc
-- neutralize the surname-mismatch penalty (the family lives there even if the
-- title surname differs); absentee_or_rental hard-excludes from T2 and adds
-- a stronger score penalty.

-- 1. The view references columns we are about to drop. Recreate it at the end.
DROP VIEW IF EXISTS v_targets;

-- 2. Drop the old tier-check constraint so recompute_tiers can transition rows
--    through the new tier letters before the new constraint clamps them.
ALTER TABLE households DROP CONSTRAINT IF EXISTS households_tier_check;

-- 3. Add the new review column.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'households' AND column_name = 'owner_voter_review'
  ) THEN
    ALTER TABLE households
      ADD COLUMN owner_voter_review text
      CHECK (owner_voter_review IS NULL
             OR owner_voter_review IN
                ('owner_lives_here','trust_or_llc','absentee_or_rental','unclear'));
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_households_review_pending
  ON households(owner_voter_review)
  WHERE owner_voter_surname_match IS FALSE;

-- 4. Drop Datazapp columns + table. CASCADE not needed: v_targets already
--    dropped above; no other reference exists.
ALTER TABLE households DROP COLUMN IF EXISTS datazapp_hit;
ALTER TABLE households DROP COLUMN IF EXISTS datazapp_match_count;

DROP TABLE IF EXISTS datazapp_imports;

-- 5. Replace recompute_tiers with the consolidated logic.
CREATE OR REPLACE FUNCTION recompute_tiers(anchor date DEFAULT current_date)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  market_value_p50 numeric;
  market_value_p75 numeric;
BEGIN
  SELECT percentile_cont(0.50) WITHIN GROUP (ORDER BY market_value),
         percentile_cont(0.75) WITHIN GROUP (ORDER BY market_value)
    INTO market_value_p50, market_value_p75
    FROM households
   WHERE market_value IS NOT NULL;

  UPDATE households h SET
    tier = CASE
      WHEN h.has_17_18_voter THEN 'T1'
      -- T2 (consolidated): voter-pattern senior-parent inference. Strict gate
      -- formerly known as T2b. Absentee/rental classifications hard-exclude.
      WHEN h.adult_42_63_count >= 2
           AND COALESCE(h.years_owned,0) >= 8
           AND h.mailing_same_as_situs
           AND NOT h.institutional_owner
           AND NOT h.has_19_20_voter
           AND COALESCE(h.owner_voter_review,'') <> 'absentee_or_rental'
        THEN 'T2'
      WHEN h.has_19_20_voter THEN 'T3'
      ELSE 'TX'
    END,
    evidence_score = (
        least(h.count_17_18_voters * 100, 120)
      + least(h.count_19_20_voters * 70, 90)
      + CASE WHEN h.adult_count >= 2 THEN 18 ELSE 0 END
      + CASE WHEN h.adult_count >= 3 THEN 10 ELSE 0 END
      + CASE WHEN h.adult_42_63_count >= 1 THEN 16 ELSE 0 END
      + CASE WHEN h.adult_45_58_count >= 2 THEN 10 ELSE 0 END
      + CASE WHEN COALESCE(h.years_owned,0) BETWEEN 8 AND 14 THEN 12 ELSE 0 END
      + CASE WHEN COALESCE(h.years_owned,0) BETWEEN 15 AND 24 THEN 18 ELSE 0 END
      + CASE WHEN COALESCE(h.years_owned,0) >= 25 THEN 22 ELSE 0 END
      + CASE WHEN h.mailing_same_as_situs THEN 8 ELSE 0 END
      + CASE WHEN h.market_value IS NOT NULL AND h.market_value >= market_value_p50 THEN 6 ELSE 0 END
      + CASE WHEN h.market_value IS NOT NULL AND h.market_value >= market_value_p75 THEN 10 ELSE 0 END
      + CASE WHEN h.same_surname_youth_to_adult THEN 2 ELSE 0 END
      -- Surname match: +6 for a direct match. A reviewed mismatch where the
      -- family is confirmed in residence (owner_lives_here, trust_or_llc) is
      -- treated the same as a match. Unreviewed mismatches keep the -3 nudge;
      -- absentee/rental classification gets a stronger -10 plus tier exclusion.
      + CASE WHEN h.owner_voter_surname_match IS TRUE THEN 6 ELSE 0 END
      + CASE WHEN h.owner_voter_surname_match IS FALSE
              AND h.owner_voter_review IN ('owner_lives_here','trust_or_llc')
             THEN 6 ELSE 0 END
      + CASE WHEN h.owner_voter_surname_match IS FALSE
              AND (h.owner_voter_review IS NULL OR h.owner_voter_review = 'unclear')
             THEN -3 ELSE 0 END
      + CASE WHEN h.owner_voter_review = 'absentee_or_rental' THEN -10 ELSE 0 END
      + CASE WHEN h.out_of_hudson_mailing THEN -40 ELSE 0 END
      + CASE WHEN h.institutional_owner THEN -30 ELSE 0 END
      + CASE WHEN h.adult_count = 1 THEN -12 ELSE 0 END
      + CASE WHEN h.oldest_voter_birth_year IS NOT NULL
              AND (anchor::date - make_date(h.oldest_voter_birth_year,6,30)) / 365 >= 65
              AND h.adult_count = 1 THEN -10 ELSE 0 END
      + CASE WHEN COALESCE(h.years_owned,0) BETWEEN 0 AND 2 THEN -8 ELSE 0 END
    )::int,
    evidence_chips = (
      SELECT jsonb_agg(chip)
        FROM (
          SELECT CASE WHEN h.has_17_18_voter THEN jsonb_build_object('k','senior_voter','t', concat(h.count_17_18_voters,' senior voter')) END AS chip
          UNION ALL
          SELECT CASE WHEN h.has_19_20_voter THEN jsonb_build_object('k','recent_grad','t', concat(h.count_19_20_voters,' recent grad voter')) END
          UNION ALL
          SELECT CASE WHEN h.adult_42_63_count >= 2 THEN jsonb_build_object('k','two_parents','t','Two parent-age adults') END
          UNION ALL
          SELECT CASE WHEN h.years_owned IS NOT NULL THEN jsonb_build_object('k','tenure','t', concat(h.years_owned,' yrs owned')) END
          UNION ALL
          SELECT CASE WHEN h.market_value IS NOT NULL AND h.market_value >= market_value_p75 THEN jsonb_build_object('k','top_q','t','Top-quartile value') END
          UNION ALL
          SELECT CASE WHEN h.owner_voter_surname_match IS TRUE
                       OR (h.owner_voter_surname_match IS FALSE
                           AND h.owner_voter_review IN ('owner_lives_here','trust_or_llc'))
                      THEN jsonb_build_object('k','owner_voter','t','Owner surname matches voter') END
          UNION ALL
          SELECT CASE WHEN h.owner_voter_review = 'absentee_or_rental' THEN jsonb_build_object('k','rental','t','Reviewed: not owner-occupied','warn',true) END
          UNION ALL
          SELECT CASE WHEN h.out_of_hudson_mailing THEN jsonb_build_object('k','absentee','t','Absentee owner','warn',true) END
        ) chips
       WHERE chip IS NOT NULL
    ),
    why_sentence = TRIM(both ' ' FROM CONCAT_WS('; ',
      CASE WHEN h.has_17_18_voter THEN CONCAT('Voter file shows ', h.count_17_18_voters, ' age-17/18 resident', CASE WHEN h.count_17_18_voters > 1 THEN 's' ELSE '' END) END,
      CASE WHEN h.has_19_20_voter AND NOT h.has_17_18_voter THEN CONCAT('Recent grad (', h.count_19_20_voters, ' age-19/20)') END,
      CASE WHEN NOT h.has_17_18_voter AND NOT h.has_19_20_voter
           AND h.adult_42_63_count >= 2 AND COALESCE(h.years_owned,0) >= 8 AND h.mailing_same_as_situs
           THEN 'Voter-pattern inferred: two parent-age adults, long tenure, owner-occupied' END,
      CASE WHEN h.adult_42_63_count >= 2 AND (h.has_17_18_voter OR h.has_19_20_voter)
           THEN 'Two adults in parent-age band' END,
      CASE WHEN h.years_owned IS NOT NULL THEN CONCAT(h.years_owned, ' years owned') END,
      CASE WHEN h.market_value IS NOT NULL AND h.market_value >= market_value_p75 THEN 'top-quartile market value' END,
      CASE WHEN h.owner_voter_surname_match IS TRUE THEN 'owner surname matches voter' END,
      CASE WHEN h.owner_voter_surname_match IS FALSE
            AND h.owner_voter_review IN ('owner_lives_here','trust_or_llc')
           THEN 'reviewed: family in residence' END,
      CASE WHEN h.owner_voter_review = 'absentee_or_rental' THEN 'reviewed: not owner-occupied' END,
      CASE WHEN h.out_of_hudson_mailing THEN 'absentee mailing' END
    ))
  WHERE h.id IS NOT NULL;
END;
$$;

ALTER FUNCTION recompute_tiers(date) SET search_path = pg_catalog, public;

-- 6. Recompute now -- forces every household onto the new tier letters before
--    the constraint locks them down.
SELECT recompute_tiers(CURRENT_DATE);

-- 7. Lock in the new tier letters.
ALTER TABLE households ADD CONSTRAINT households_tier_check
  CHECK (tier = ANY (ARRAY['T1','T2','T3','TX']::text[]));

-- 8. Default visible tiers: T1 + T2. T3 stays opt-in via the "Adjacent" intro.
ALTER TABLE user_preferences
  ALTER COLUMN default_visible_tiers SET DEFAULT '["T1","T2"]'::jsonb;

-- 9. Recreate v_targets without DZ columns; expose owner_voter_review so the
--    dev review tool can show progress without a separate query. Preserves
--    resident_names from migration _016.
DROP VIEW IF EXISTS public.v_targets;
CREATE VIEW public.v_targets AS
  SELECT
    h.id              AS household_id,
    h.address_key,
    h.parcel_id,
    h.display_name,
    h.surname_key,
    h.owner_names,
    h.resident_names,
    h.owner_voter_surname_match,
    h.owner_voter_review,
    h.situs_address,
    h.situs_city,
    h.situs_zip,
    h.lat, h.lng,
    h.market_value,
    h.sqft,
    h.year_built,
    h.years_owned,
    h.mailing_same_as_situs,
    h.parcel_owner_occupied_local,
    h.voter_count,
    h.has_17_18_voter, h.count_17_18_voters,
    h.has_19_20_voter, h.count_19_20_voters,
    h.adult_count, h.adult_42_63_count, h.adult_45_58_count,
    h.same_surname_youth_to_adult,
    h.senior_reg_date_min,
    h.tier,
    h.evidence_score,
    h.evidence_chips,
    h.why_sentence,
    h.institutional_owner,
    h.out_of_hudson_mailing,
    h.refreshed_at
  FROM public.households h
;

GRANT SELECT ON public.v_targets TO anon, authenticated;
