-- Tighten T2 ("Likely Senior - Family on File") into the launching-window
-- pattern, and rename it accordingly. The previous gate fired on any
-- parent-age couple plus 1+ extra adult voters, which mis-fired on:
--   * permanent multi-generational households (e.g. parent-couple + 4 adult
--     kids in their late 20s/30s)
--   * long-launched families where extras are 26+ (no current senior signal)
--   * blended/boomerang households with adult kids 27-31 still on rolls
-- The voter file alone cannot reliably distinguish "current HS senior here"
-- from "21+ year-old at home" once the only signal is "3+ adults." The signal
-- the data actually supports is *life stage* — the household is in the
-- launching window — so the new gate matches the data and the label changes
-- to match the gate.
--
-- New T2 ("Empty-Nester Window - Kids in their 20s on File"):
--   * Exactly 2 parent-age adults (42-63)
--   * 1 or 2 extra adult voters, ALL aged 21-25
--   * No adult voter aged 26+ (catches multi-gen / long-launched patterns)
--   * Existing gates: 8+ years owned, owner-occupied, non-institutional,
--     no 19/20-voter (else T3), no 17/18-voter (else T1), not absentee_or_rental
--
-- T2c ("Couple in Parent Age Range") is unchanged.
--
-- Households that previously qualified for T2 but had any adult 26+ on file,
-- or 3+ extra adults of any age, fall through to TX.

ALTER TABLE households
  ADD COLUMN IF NOT EXISTS adult_21_25_count int DEFAULT 0,
  ADD COLUMN IF NOT EXISTS adult_26plus_count int DEFAULT 0;

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
      WHEN h.adult_42_63_count = 2
           AND COALESCE(h.years_owned,0) >= 8
           AND h.mailing_same_as_situs
           AND NOT h.institutional_owner
           AND NOT h.has_19_20_voter
           AND COALESCE(h.owner_voter_review,'') <> 'absentee_or_rental'
           AND h.adult_count BETWEEN 3 AND 4
           AND COALESCE(h.adult_21_25_count,0) >= (h.adult_count - h.adult_42_63_count)
           AND COALESCE(h.adult_26plus_count,0) = h.adult_42_63_count
        THEN 'T2'
      WHEN h.adult_42_63_count >= 2
           AND COALESCE(h.years_owned,0) >= 8
           AND h.mailing_same_as_situs
           AND NOT h.institutional_owner
           AND NOT h.has_19_20_voter
           AND COALESCE(h.owner_voter_review,'') <> 'absentee_or_rental'
           AND h.adult_count = 2
        THEN 'T2c'
      WHEN h.has_19_20_voter THEN 'T3'
      ELSE 'TX'
    END,
    evidence_score = (
        least(h.count_17_18_voters * 100, 120)
      + least(h.count_19_20_voters * 70, 90)
      + CASE WHEN h.adult_count >= 2 THEN 18 ELSE 0 END
      + CASE WHEN h.adult_count >= 3 AND COALESCE(h.adult_21_25_count,0) >= 1 THEN 10 ELSE 0 END
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
          SELECT CASE WHEN COALESCE(h.adult_21_25_count,0) >= 1 AND h.adult_count >= 3 THEN jsonb_build_object('k','launching','t', concat(h.adult_21_25_count,' adult kid 21-25 on file')) END
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
           AND h.adult_42_63_count = 2
           AND h.adult_count BETWEEN 3 AND 4
           AND COALESCE(h.adult_21_25_count,0) >= (h.adult_count - 2)
           AND COALESCE(h.adult_26plus_count,0) = 2
           AND COALESCE(h.years_owned,0) >= 8 AND h.mailing_same_as_situs
           THEN CONCAT('Parent-age couple plus ', (h.adult_count - 2), ' adult-age child', CASE WHEN h.adult_count - 2 > 1 THEN 'ren' ELSE '' END,
                      ' on file (age 21-25) -- empty-nester window') END,
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
