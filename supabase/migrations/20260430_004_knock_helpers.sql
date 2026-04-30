-- Knock-tracking helpers: ergonomic RPCs that the frontend calls.

-- Mark a household knocked in the active campaign.
-- Pass cooldown_days_override to set a per-house cooldown (else uses prefs default).
create or replace function mark_knocked(
  p_household_id uuid,
  p_outcome text default 'knocked',
  p_note text default '',
  p_cooldown_days_override int default null
) returns void
language plpgsql security invoker
as $$
declare
  v_user uuid := auth.uid();
  v_campaign uuid;
  v_default_cd int;
  v_cooldown_until date;
begin
  if v_user is null then
    raise exception 'auth required';
  end if;

  select default_campaign_id, default_cooldown_days
    into v_campaign, v_default_cd
    from user_preferences where user_id = v_user;

  if v_campaign is null then
    select id into v_campaign from campaigns
      where user_id = v_user and is_active
      order by started_at desc limit 1;
  end if;

  if v_campaign is null then
    raise exception 'no active campaign — create one first';
  end if;

  v_cooldown_until := current_date + (coalesce(p_cooldown_days_override, v_default_cd, 30) || ' days')::interval;

  insert into knock_events(user_id, campaign_id, household_id, outcome, note, cooldown_days_override)
    values (v_user, v_campaign, p_household_id, p_outcome, coalesce(p_note,''), p_cooldown_days_override);

  insert into campaign_household_state(
      user_id, campaign_id, household_id,
      status, cooldown_until, last_outcome, last_note, last_action_at
    )
    values (
      v_user, v_campaign, p_household_id,
      case when p_outcome = 'follow_up' then 'ready' else 'knocked' end,
      v_cooldown_until,
      p_outcome,
      coalesce(p_note,''),
      now()
    )
  on conflict (campaign_id, household_id) do update
    set status = excluded.status,
        cooldown_until = excluded.cooldown_until,
        last_outcome = excluded.last_outcome,
        last_note = excluded.last_note,
        follow_up_requested = (excluded.last_outcome = 'follow_up'),
        last_action_at = excluded.last_action_at;
end;
$$;

-- Reset a household to 'ready' (undo knock).
create or replace function reset_knock(p_household_id uuid)
returns void
language plpgsql security invoker
as $$
declare
  v_user uuid := auth.uid();
  v_campaign uuid;
begin
  if v_user is null then
    raise exception 'auth required';
  end if;
  select id into v_campaign from campaigns
    where user_id = v_user and is_active
    order by started_at desc limit 1;
  if v_campaign is null then
    return;
  end if;
  update campaign_household_state
     set status='ready', cooldown_until=null, last_action_at=now()
   where campaign_id=v_campaign and household_id=p_household_id and user_id=v_user;
end;
$$;

-- Active-campaign rollup view: joins household + campaign state + knock derived flags.
create or replace view v_active_campaign_state as
  select
    chs.user_id,
    chs.campaign_id,
    chs.household_id,
    chs.status,
    chs.cooldown_until,
    case
      when chs.cooldown_until is null then 'ready'
      when chs.cooldown_until <= current_date then 'ready'
      else 'cooling'
    end as readiness,
    chs.follow_up_requested,
    chs.last_outcome,
    chs.last_note,
    chs.last_action_at
  from campaign_household_state chs
;
