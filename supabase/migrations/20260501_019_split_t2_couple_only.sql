-- Split T2 ("Likely Senior — Parent Pattern") into two tiers based on whether
-- there's any signal of adult children at the address.
--   T2  (kept name): >=3 adults total at the address. The two parent-age
--       adults plus at least one more adult voter — typically an adult-age
--       child still living at home (or an extended-family member). This is
--       the meaningful "family on file" pattern.
--   T2c (new):       exactly 2 adults, both in the 42-63 band. Strict couple-
--       only — the "parent pattern" is just a couple in the right age range,
--       no actual evidence of children. Weaker signal; opt-in.
-- Other T2 gates (8+ yrs owned, owner-occupied, non-institutional, no
-- 19/20-voter, not absentee_or_rental review) carry through to both tiers.

ALTER TABLE households DROP CONSTRAINT IF EXISTS households_tier_check;
ALTER TABLE households ADD CONSTRAINT households_tier_check
  CHECK (tier = ANY (ARRAY['T1','T2','T2c','T3','TX']::text[]));

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
      WHEN h.adult_42_63_count >= 2
           AND COALESCE(h.years_owned,0) >= 8
           AND h.mailing_same_as_situs
           AND NOT h.institutional_owner
           AND NOT h.has_19_20_voter
           AND COALESCE(h.owner_voter_review,'') <> 'absentee_or_rental'
        THEN CASE WHEN h.adult_count >= 3 THEN 'T2' ELSE 'T2c' END
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
          SELECT CASE WHEN h.adult_count >= 3 THEN jsonb_build_object('k','three_adults','t', concat(h.adult_count,' adults at address')) END
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
           AND h.adult_42_63_count >= 2 AND h.adult_count >= 3 AND COALESCE(h.years_owned,0) >= 8 AND h.mailing_same_as_situs
           THEN CONCAT(h.adult_count, ' adults at address (parent-age couple plus at least one more adult on file)') END,
      CASE WHEN NOT h.has_17_18_voter AND NOT h.has_19_20_voter
           AND h.adult_42_63_count >= 2 AND h.adult_count = 2 AND COALESCE(h.years_owned,0) >= 8 AND h.mailing_same_as_situs
           THEN 'Couple in the parent age range (42-63), long tenure, owner-occupied -- no other adults on file' END,
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

SELECT recompute_tiers(CURRENT_DATE);
