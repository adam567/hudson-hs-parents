# Hudson HS Parents

A seasonal door-knocking targeting tool for one Hudson, OH (44236) real-estate agent. Surfaces likely senior-parent households as pins on an interactive map, scores them by signal strength, lets her plan walks her own way.

**Live:** https://adam567.github.io/hudson-hs-parents/

## What it does

- Pulls Hudson 44236 parcels from Summit County's public ArcGIS REST + sale-transfer file
- Joins to the Ohio Secretary of State voter file (refreshed weekly during active campaigns)
- Overlays Datazapp's "College-Bound Senior" mailing list (annual purchase, ~$125)
- Classifies every owner-occupied address into a tier:
  - **T1** — voter file shows a current 17/18-year-old at the address (Class of 2026 ground truth)
  - **T2** — voter file shows a 19/20-year-old (recent grad, fall-campaign cohort)
  - **T3** — Datazapp + 2 parent-age adults at address (likely senior, voter file missed)
  - **T4** — Datazapp + 1 parent-age adult (younger-sibling keeper, multi-year)
  - **T5** — Datazapp-only weak inference
- Shows them as size-and-color-coded pins. Stronger signal = bigger, more saturated, with a colored halo. Weaker signal = smaller, faded.
- Filters by tier, cohort chips, value, tenure, sqft, year built, mailing scrub, drawn polygon.
- One-tap "mark knocked" with configurable cooldown (global default + per-house override).
- Saved filter recipes, saved drawn areas, named campaigns.
- Exports: plain CSV, Google "My Maps" CSV, Avery 5160/5161/5163/5164 mail-merge CSVs, printable cluster packet.
- Optional email digest with operator-configurable cadence (off / on-demand / daily / weekdays / weekly Monday).

## Tier counts (current data, anchor 2026-05-01)

| Tier | Count | Rule |
|---|---:|---|
| T1 Current senior | ~198 | 17/18yo voter at address |
| T2 Recent grad | ~501 | 19/20yo voter at address |
| T3 Likely senior | ~482 | Datazapp + 2 parent-age adults |
| T4 Younger-sibling keeper | ~202 | Datazapp + 1 parent-age adult |
| T5 Weak inference | ~466 | Datazapp-only |

Spring 2026 actionable cohort: T1 + T3 ≈ **680 households**.

## Stack

- **Backend:** Supabase (Postgres + Auth + RLS + Edge Functions)
- **Frontend:** vanilla JS + Leaflet + Leaflet.draw, served from GitHub Pages
- **Pipeline:** Python on GitHub Actions (weekly voter, monthly parcel, annual Datazapp)
- **Mail:** Resend (optional digest)

## Layout

```
site/                           static frontend (index.html, app.js, styles.css)
scripts/
  address_key.py                canonical address normalization
  supabase_client.py            REST helper
  load_parcels.py               ArcGIS + SC706_SALES → parcels table
  load_voter_file.py            Ohio voter CSV → voter_records
  load_datazapp.py              Datazapp CSV → datazapp_imports (batched)
  build_households.py           join + rollup + recompute_tiers
  send_digest.py                email digest (optional)
  dry_run_join.py               local sanity-check (no Supabase)
supabase/
  migrations/                   schema, RLS, tier-recompute, knock helpers
  functions/pdf_packet/         Edge Function: door-knock packet
.github/workflows/              refresh, digest, Pages, DB push
tests/                          pytest tests for address_key
data/                           voter & datazapp CSV inputs (operator-supplied)
```

## What's the right way to use it

It's seasonal. Run a campaign for a few weeks each spring around HS graduation, optionally a fall pass for incoming senior parents. Outside those windows it sits idle and the home screen says so honestly.

The map is for distribution awareness and walking-route planning. The system never auto-picks her cluster of the day — she sees the pins, draws her own polygons, exports what she wants.

See `SETUP.md` for one-time provisioning.
