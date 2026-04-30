-- Saved lists: a lightweight, organically-created "campaign record".
-- (Renamed to "tags" in 009 — kept here so the migration history matches
-- the live DB.)

create table if not exists lists (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  name text not null,
  household_ids uuid[] not null default '{}',
  notes text default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, name)
);
create index if not exists idx_lists_user on lists(user_id);

alter table lists enable row level security;

drop policy if exists lists_self on lists;
create policy lists_self on lists
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop trigger if exists trg_lists_updated on lists;
create trigger trg_lists_updated before update on lists
  for each row execute function set_updated_at();
