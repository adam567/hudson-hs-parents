-- Supabase enables safeupdate at the PostgREST gateway; an UPDATE without a
-- WHERE clause raises 21000 "UPDATE requires a WHERE clause". Add an
-- always-true predicate so recompute_tiers passes the hook while still
-- updating every household row.

create or replace function recompute_tiers(anchor date default current_date)
returns void
language plpgsql
as $$
declare
  market_value_p50 numeric;
  market_value_p75 numeric;
begin
  select percentile_cont(0.50) within group (order by market_value),
         percentile_cont(0.75) within group (order by market_value)
    into market_value_p50, market_value_p75
    from households
    where market_value is not null;

  update households h set
    tier = case
      when h.has_17_18_voter then 'T1'
      when h.has_19_20_voter then 'T2'
      when h.datazapp_hit and h.adult_42_63_count >= 2 and coalesce(h.years_owned,0) >= 8 then 'T3'
      when h.datazapp_hit and h.adult_42_63_count >= 1 then 'T4'
      when h.datazapp_hit then 'T5'
      else 'TX'
    end,
    evidence_score = (
        least(h.count_17_18_voters * 100, 120)
      + least(h.count_19_20_voters * 70, 90)
      + case when h.datazapp_hit then 35 else 0 end
      + case when h.adult_count >= 2 then 18 else 0 end
      + case when h.adult_count >= 3 then 10 else 0 end
      + case when h.adult_42_63_count >= 1 then 16 else 0 end
      + case when h.adult_45_58_count >= 2 then 10 else 0 end
      + case when coalesce(h.years_owned,0) between 8 and 14 then 12 else 0 end
      + case when coalesce(h.years_owned,0) between 15 and 24 then 18 else 0 end
      + case when coalesce(h.years_owned,0) >= 25 then 22 else 0 end
      + case when h.mailing_same_as_situs then 8 else 0 end
      + case when h.market_value is not null and h.market_value >= market_value_p50 then 6 else 0 end
      + case when h.market_value is not null and h.market_value >= market_value_p75 then 10 else 0 end
      + case when h.same_surname_youth_to_adult then 2 else 0 end
      + case when h.out_of_hudson_mailing then -40 else 0 end
      + case when h.institutional_owner then -30 else 0 end
      + case when h.adult_count = 1 then -12 else 0 end
      + case when h.oldest_voter_birth_year is not null
              and (anchor::date - make_date(h.oldest_voter_birth_year,6,30)) / 365 >= 65
              and h.adult_count = 1 then -10 else 0 end
      + case when coalesce(h.years_owned,0) between 0 and 2 then -8 else 0 end
    )::int,
    evidence_chips = (
      select jsonb_agg(chip)
      from (
        select case when h.has_17_18_voter then jsonb_build_object('k','senior_voter','t', concat(h.count_17_18_voters,' senior voter')) end as chip
        union all
        select case when h.has_19_20_voter then jsonb_build_object('k','recent_grad','t', concat(h.count_19_20_voters,' recent grad voter')) end
        union all
        select case when h.datazapp_hit then jsonb_build_object('k','datazapp','t','Datazapp match') end
        union all
        select case when h.adult_42_63_count >= 2 then jsonb_build_object('k','two_parents','t','Two parent-age adults') end
        union all
        select case when h.years_owned is not null then jsonb_build_object('k','tenure','t', concat(h.years_owned,' yrs owned')) end
        union all
        select case when h.market_value is not null and h.market_value >= market_value_p75 then jsonb_build_object('k','top_q','t','Top-quartile value') end
        union all
        select case when h.out_of_hudson_mailing then jsonb_build_object('k','absentee','t','Absentee owner','warn',true) end
      ) chips
      where chip is not null
    ),
    why_sentence = trim(both ' ' from concat_ws('; ',
      case when h.has_17_18_voter then concat('Voter file shows ', h.count_17_18_voters, ' age-17/18 resident', case when h.count_17_18_voters > 1 then 's' else '' end) end,
      case when h.has_19_20_voter and not h.has_17_18_voter then concat('Recent grad (', h.count_19_20_voters, ' age-19/20)') end,
      case when h.datazapp_hit then 'Datazapp College-Bound match' end,
      case when h.adult_42_63_count >= 2 then 'Two adults in parent-age band' end,
      case when h.years_owned is not null then concat(h.years_owned, ' years owned') end,
      case when h.market_value is not null and h.market_value >= market_value_p75 then 'top-quartile market value' end,
      case when h.out_of_hudson_mailing then 'absentee mailing' end
    ))
  where h.id is not null;
end;
$$;

alter function recompute_tiers(date) set search_path = pg_catalog, public;
