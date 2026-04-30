-- Reframe "lists" as "tags" — CRM-shaped, reusable labels that a household
-- can carry many of. Same data shape, different UX.

alter table lists rename to tags;
alter index idx_lists_user rename to idx_tags_user;
alter trigger trg_lists_updated on tags rename to trg_tags_updated;

drop policy if exists lists_self on tags;
create policy tags_self on tags
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
