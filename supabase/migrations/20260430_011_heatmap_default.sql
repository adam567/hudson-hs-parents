-- Density heatmap should be on by default; it's the visual signal that makes
-- the map immediately legible.

alter table user_preferences alter column default_heatmap_on set default true;
