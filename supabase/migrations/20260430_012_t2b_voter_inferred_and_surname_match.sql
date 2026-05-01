-- T2b: voter-pattern-only "likely senior parents" inference. Households where the
-- voter file alone shows a probable Class-of-2026 senior-parent profile but
-- Datazapp didn't independently confirm. Keeps T2 as the strict DZ-corroborated
-- tier so the user holds a precision/recall dial: T1+T2 by default, opt into T2b.
--
-- Also adds owner_voter_surname_match as a soft three-state corroboration
-- feature (match/mismatch/unknown). Used as a scoring boost / chip but
-- never as a hard tier gate (per Codex peer review: trusts/maiden names/
-- hyphenation/single-spouse-on-title make hard-gating brittle).
--
-- Bug fix: surname_key in build_households.py uses owner1_raw.split()[-1],
-- which yields the *middle initial* or "JR" / "LLC" for "LASTNAME FIRSTNAME M"
-- formatted parcels. We compute owner surname here from SPLIT_PART(owner1, ' ', 1)
-- which is the actual surname for Summit County's parcel owner format.

ALTER TABLE households DROP CONSTRAINT IF EXISTS households_tier_check;
ALTER TABLE households ADD CONSTRAINT households_tier_check
  CHECK (tier = ANY (ARRAY['T1','T2','T2b','T3','T4','T5','TX']::text[]));

ALTER TABLE households
  ADD COLUMN IF NOT EXISTS owner_voter_surname_match boolean;

WITH owner_keys AS (
  SELECT
    h.id AS hh_id,
    h.address_key,
    UPPER(NULLIF(REGEXP_REPLACE(SPLIT_PART(COALESCE(h.owner_names[1], ''), ' ', 1), '[^A-Za-z]', '', 'g'), '')) AS owner_sn
  FROM households h
  WHERE NOT h.institutional_owner
),
voter_sn AS (
  SELECT
    vr.address_key,
    array_agg(DISTINCT UPPER(REGEXP_REPLACE(COALESCE(vr.last_name,''), '[^A-Za-z]','','g'))) AS sns
  FROM voter_records vr
  WHERE vr.last_name IS NOT NULL AND vr.last_name <> ''
  GROUP BY vr.address_key
)
UPDATE households h
   SET owner_voter_surname_match =
       CASE
         WHEN ok.owner_sn IS NULL OR vs.sns IS NULL THEN NULL
         WHEN ok.owner_sn = ANY(vs.sns) THEN TRUE
         ELSE FALSE
       END
  FROM owner_keys ok
  LEFT JOIN voter_sn vs ON vs.address_key = ok.address_key
 WHERE ok.hh_id = h.id;

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
      WHEN h.datazapp_hit AND h.adult_42_63_count >= 2 AND COALESCE(h.years_owned,0) >= 8 THEN 'T2'
      -- T2b: voter-pattern only. NO datazapp signal, NO 17/18 or 19/20 voter,
      -- two parent-age adults at home, long tenure, owner-occupied.
      WHEN NOT h.datazapp_hit
           AND NOT h.has_19_20_voter
           AND h.adult_42_63_count >= 2
           AND COALESCE(h.years_owned,0) >= 8
           AND h.mailing_same_as_situs
           AND NOT h.institutional_owner
        THEN 'T2b'
      WHEN h.has_19_20_voter THEN 'T3'
      WHEN h.datazapp_hit AND h.adult_42_63_count >= 1 THEN 'T4'
      WHEN h.datazapp_hit THEN 'T5'
      ELSE 'TX'
    END,
    evidence_score = (
        least(h.count_17_18_voters * 100, 120)
      + least(h.count_19_20_voters * 70, 90)
      + CASE WHEN h.datazapp_hit THEN 35 ELSE 0 END
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
      + CASE WHEN h.owner_voter_surname_match IS FALSE THEN -3 ELSE 0 END
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
          SELECT CASE WHEN h.datazapp_hit THEN jsonb_build_object('k','datazapp','t','Datazapp match') END
          UNION ALL
          SELECT CASE WHEN h.adult_42_63_count >= 2 THEN jsonb_build_object('k','two_parents','t','Two parent-age adults') END
          UNION ALL
          SELECT CASE WHEN h.years_owned IS NOT NULL THEN jsonb_build_object('k','tenure','t', concat(h.years_owned,' yrs owned')) END
          UNION ALL
          SELECT CASE WHEN h.market_value IS NOT NULL AND h.market_value >= market_value_p75 THEN jsonb_build_object('k','top_q','t','Top-quartile value') END
          UNION ALL
          SELECT CASE WHEN h.owner_voter_surname_match IS TRUE THEN jsonb_build_object('k','owner_voter','t','Owner surname matches voter') END
          UNION ALL
          SELECT CASE WHEN h.out_of_hudson_mailing THEN jsonb_build_object('k','absentee','t','Absentee owner','warn',true) END
        ) chips
       WHERE chip IS NOT NULL
    ),
    why_sentence = TRIM(both ' ' FROM CONCAT_WS('; ',
      CASE WHEN h.has_17_18_voter THEN CONCAT('Voter file shows ', h.count_17_18_voters, ' age-17/18 resident', CASE WHEN h.count_17_18_voters > 1 THEN 's' ELSE '' END) END,
      CASE WHEN h.has_19_20_voter AND NOT h.has_17_18_voter THEN CONCAT('Recent grad (', h.count_19_20_voters, ' age-19/20)') END,
      CASE WHEN h.datazapp_hit THEN 'Datazapp College-Bound match' END,
      CASE WHEN NOT h.datazapp_hit AND NOT h.has_17_18_voter AND NOT h.has_19_20_voter
           AND h.adult_42_63_count >= 2 AND COALESCE(h.years_owned,0) >= 8 AND h.mailing_same_as_situs
           THEN 'Voter-pattern inferred: parents-age adults, long tenure, owner-occupied' END,
      CASE WHEN h.adult_42_63_count >= 2 AND (h.datazapp_hit OR h.has_17_18_voter OR h.has_19_20_voter)
           THEN 'Two adults in parent-age band' END,
      CASE WHEN h.years_owned IS NOT NULL THEN CONCAT(h.years_owned, ' years owned') END,
      CASE WHEN h.market_value IS NOT NULL AND h.market_value >= market_value_p75 THEN 'top-quartile market value' END,
      CASE WHEN h.owner_voter_surname_match IS TRUE THEN 'owner surname matches voter' END,
      CASE WHEN h.out_of_hudson_mailing THEN 'absentee mailing' END
    ))
  WHERE h.id IS NOT NULL;
END;
$$;

ALTER FUNCTION recompute_tiers(date) SET search_path = pg_catalog, public;

ALTER TABLE user_preferences ALTER COLUMN default_visible_tiers SET DEFAULT '["T1","T2"]'::jsonb;

SELECT recompute_tiers(CURRENT_DATE);
