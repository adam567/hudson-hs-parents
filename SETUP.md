# Hudson HS Parents — Setup

One-time provisioning. Budget ~30 minutes.

## 1. Create the Supabase project

1. https://supabase.com → **New Project** → name `hudson-hs-parents`. US East region, save the DB password.
2. After provisioning, grab from **Project Settings → API**:
   - `Project URL`
   - `anon public` key
   - `service_role` key

## 2. Apply the schema

In Supabase **SQL Editor**, paste each of these in order:

1. `supabase/migrations/20260430_001_schema.sql`
2. `supabase/migrations/20260430_002_rls.sql`
3. `supabase/migrations/20260430_003_tier_view.sql`
4. `supabase/migrations/20260430_004_knock_helpers.sql`

Or via the CLI:

```bash
npm i -g supabase
supabase login
supabase link --project-ref <your-project-ref>
supabase db push --include-all
```

## 3. Invite the user

1. **Authentication → Users → Invite user** with the agent's email.
2. After she signs in once, the trigger creates her `user_preferences` row automatically.

## 4. Stage the data files

One CSV goes in `data/` (gitignored — never commit it):

- `data/voter/latest.csv` — Ohio voter file filtered to Hudson + Peninsula (or full Summit; the loader filters)

For local first run, point the scripts directly at the files you have:

```bash
export SUPABASE_URL="https://...supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="..."
python scripts/load_parcels.py
python scripts/load_voter_file.py "C:/realestate/VoterRolls/voterfile (1).csv"
python scripts/build_households.py --anchor 2026-05-01
```

Last command runs `recompute_tiers` and prints tier counts. T1 should be the
voter-confirmed senior addresses; T2 is the consolidated voter-pattern tier
(two parent-age adults, 8+ years owned, owner-occupied, non-institutional);
T3 is recent-grad (off-thesis adjacent).

## 5. Configure GitHub repo

Repo: `heatmap` (new sibling to `hudson-leads`)

Secrets (Settings → Secrets and variables → Actions):

| Name | Value |
|---|---|
| `SUPABASE_URL` | from step 1 |
| `SUPABASE_ANON_KEY` | from step 1 |
| `SUPABASE_SERVICE_ROLE_KEY` | from step 1 |
| `SUPABASE_ACCESS_TOKEN` | a personal access token from supabase.com/dashboard/account/tokens |
| `SUPABASE_PROJECT_REF` | your project ref (the `xxxx` in `xxxx.supabase.co`) |
| `SUPABASE_DB_PASSWORD` | the DB password from step 1 |
| `RESEND_API_KEY` | optional; only if email digest is enabled |

Variables:

| Name | Default |
|---|---|
| `TARGET_ZIPS` | `44236,44264` |
| `TARGET_CITIES` | `HUDSON,PENINSULA` |
| `DIGEST_FROM` | `Hudson HS Parents <noreply@yourdomain.com>` |

Settings → Pages → Source: **GitHub Actions**.

## 6. Push to main

The first push triggers:
- `deploy-pages.yml` — injects Supabase config and publishes the site
- `deploy-db.yml` — pushes migrations + Edge Functions

Visit `https://adam567.github.io/heatmap/`. Sign in with the invited email, paste the OTP. The map loads.

## 7. First campaign

In the app:
1. Top right → "Start a campaign"
2. Name: `Spring 2026`. Season: `spring`. Anchor: `2026-05-01`. School year: `2025-2026`.
3. The pin counts and visible map populate immediately.

## What runs automatically

- **Mondays 06:17 UTC** — voter + parcel refresh, tier recompute (`refresh-data.yml`)
- **Daily 11:00 UTC** — digest sender (only emails users whose cadence is due)
- **On push to `main`** touching `site/**` — Pages redeploy
- **On push to `main`** touching `supabase/**` — DB + functions push

## Costs

- **Supabase free tier:** fits this app for years
- **GitHub Pages + Actions:** unlimited for public repos
- **Resend:** free tier covers the digest volume
- **Total recurring:** $0/yr (public records only)
