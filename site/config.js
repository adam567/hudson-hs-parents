// Browser-side config. Two values to set after Supabase is provisioned.
// Both are safe to expose publicly — RLS in Postgres is the security boundary.
window.HHSP_CONFIG = {
  SUPABASE_URL: "https://YOUR-PROJECT.supabase.co",
  SUPABASE_ANON_KEY: "YOUR_ANON_KEY"
};
