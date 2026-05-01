# Filtering strategy: choices, limitations, and what to verify

Snapshot taken 2026-04-30. This document summarises the changes shipped in
migration `20260430_012_t2b_voter_inferred_and_surname_match.sql`, the
assumptions baked into them, the alternatives that were considered and
rejected, and the specific things to fact-check before relitigating any of
the choices. Reviewed against two independent peer agents (Gemini, Codex)
who agreed on every recommendation listed below; their disagreements are
noted explicitly.

## 1. The "$2/lead" diagnosis (and what it actually means)

The frustration anchored on "61 likely seniors." That number turned out to
be the **gold-standard triple intersection**:

| filter | count |
|---|---:|
| voter-confirmed senior (T1) | 180 |
| T1 ∩ Datazapp (`has_17_18_voter AND datazapp_hit`) | 94 |
| T1 ∩ Datazapp ∩ tenure ≥ 8 | **62** |

So **62 (not 61)** is "the voter file confirms a senior here, AND Datazapp
agrees, AND the family has lived there 8+ years." That's the most certain
slice — every other signal corroborates the same kid. It is *not* the size
of the door-knock universe.

The actual production T2 ("likely senior, Datazapp + 2 parent-age adults +
8+ year tenure") is **476** households, and the new T2b inferred tier adds
**543** more. So the targeted door-knock universe before this work was 656
(T1+T2); after this work it can be up to 1,199 (T1+T2+T2b) when the user
opts the inferred tier on.

## 2. What changed

### 2a. New tier: T2b — voter-pattern inference, no Datazapp

**Rule:** no Datazapp hit, no 17/18 or 19/20-yo voter at the address, two
voter-registered adults aged 42–63, 8+ years owned, owner-occupied,
non-institutional owner.

**Why:** The voter file shows ~163 missing seniors against the NCES class
size of 343 (180 of 343 are voter-confirmed; the rest haven't registered
yet, registered at college, or never registered). The "two parent-age
voters at a long-tenure owner-occupied address with no kid voter" pattern
is the textbook profile for an unregistered HS senior's parents. We were
silently dumping all 543 such households into TX.

**Default state:** off. T1 + T2 are visible by default; T2b is a precision
dial the user opts into when they want to expand recall.

**Peer review note:** Both Gemini and Codex strongly recommended the *split*
(T2 + T2b) over a *disjunctive merge*. A merged T2 of 1,019 households
would mix high-precision DZ-corroborated leads with inferred ones at
roughly 50/50 — destroying the calibration the user trusts T2 for.

### 2b. New feature: `owner_voter_surname_match`

Three-state boolean (`true` / `false` / `null`) computed once at migration
time from `households.owner_names[1]` (parcel owner, first whitespace-token
= surname under Summit County's `LASTNAME FIRSTNAME [MIDDLE]` convention)
against the deduplicated set of voter `last_name`s at the same address.

**Distribution:** 4,923 match · 343 mismatch · 4,201 unknown (no voter or
institutional owner).

**Used as:** scoring boost (+6 for match, −3 for mismatch) and an evidence
chip in the drawer. **Never** as a hard tier gate.

**Peer review note:** Codex was firm that surname linkage is unreliable as
a hard eligibility key — trusts, maiden/married mismatches, hyphenation,
single-spouse-on-title, and estates all produce false negatives. Gemini
preferred a hard gate for inferred tiers. We followed Codex because the
mismatch rate (343 of 5,266 = 6.5%) is small enough that the score
penalty captures the signal without filtering useful leads.

### 2c. Bug fix: surname extraction

`build_households.py` previously stored `surname_key = owner1_raw.split()[-1].upper()`,
which yielded the **middle initial**, "JR", or "LLC" for parcels formatted
"LASTNAME FIRSTNAME M". Fixed to use `.split()[0]`, the surname.

Sample of broken data fixed by the migration:

| owner_names[1] | old surname_key (broken) | new surname_key |
|---|---|---|
| `SMITH DOUGLAS L` | `L` | `SMITH` |
| `CAPANNA ROBERT L JR` | `JR` | `CAPANNA` |
| `PRONTIKER BETH A` | `A` | `PRONTIKER` |

That's 4,000+ households whose surname-based downstream signals were
silently noise before this fix.

### 2d. Mobile-responsive frontend (already shipped)

Off-canvas sidebar + bottom-sheet drawer + full-bleed map on phones.
Marker hit-area expanded to 28×28 wrapper around the visual dot. Cache-
busted to `?v=t2b1` to force phone Safari to reload.

## 3. Limitations and unverified assumptions

These are the assumptions baked into the targeting model. Either peer flagged
each one as fragile in some way; the most fragile is listed first.

### 3a. (HIGH) `CITY=HUDSON` AND `ZIP=44236` ≠ Hudson High School District

**The problem.** Both `load_voter_file.py:39` and `load_parcels.py:84` filter
on `CITY=HUDSON AND ZIP=44236`. **Hudson City School District (NCES ID
3905002) is not contiguous with the City of Hudson or with ZIP 44236.**
HCSD draws students from parts of:

- **Boston Heights** (a separate village, but mostly in ZIP 44236, so
  probably already captured)
- **Peninsula** (ZIP 44264, almost certainly **excluded** today)
- Pieces of unincorporated Hudson Township and Boston Township

**Impact estimate.** If 5–10% of the Class of 2026 lives outside
ZIP 44236, that's 17–34 missing senior households at the absolute top of
the funnel — and they are likely the highest-quality leads (rural-edge
homes tend to be high-tenure, top-quartile value).

**How to verify.** Pull the voter file with `CITY=HUDSON OR CITY=PENINSULA`
(or filter against an actual district-boundary GeoJSON) and rerun the
build. If the 44264 voter rows include any 17/18-yo records at owner-
occupied parcels, the current pipeline is dropping confirmed seniors.

**Sources peer-cited:**
- Hudson City School District residency policy: <https://www.hudson.k12.oh.us/registration/address-change>
- NCES district profile: <https://nces.ed.gov/ccd/districtsearch/district_detail.asp?ID2=3905002>

### 3b. (MEDIUM) `years_owned IS NULL` does not always mean "long tenure"

**The problem.** `load_parcels.py:153` derives `years_owned` from the latest
sale date in `SC706_SALES.zip`. NULL means "no sale on file." I confirmed
via direct browser scrape against the Summit County iasWorld system that
**iasWorld also has no sale data for at least one NULL-tenure parcel**
(parcel 3001215, SCHULTZ at 5520 Hudson Dr, built 1989, $1.28M). So for
**residential** parcels with year_built set, NULL is highly likely to mean
"original-owner long tenure." But for non-residential parcels (HOA
common areas, parks, churches, vacant lots) NULL means "no transaction
ever applied." The two are not the same.

**Counts that justify caution.** 573 parcels have NULL years_owned. Of
those, only **22 households** have any parent-age signal, **6** have two
parent-age adults, and **0** have Datazapp + two adults — so NULL-tenure
recovery is a 4-to-6-lead lever at best, not a 100-lead lever. Codex's
warning here was correct: **do not** treat NULL as "≥ 8 years."

**Optional follow-up.** Apply `years_owned = COALESCE(years_owned,
GREATEST(0, anchor_year - year_built))` *only* for owner-occupied,
non-institutional parcels with year_built present. This recovers ~4 T2b
candidates and adds tenure scoring weight to ~250 long-tenure homes that
would otherwise score lower. Not shipped because the impact is marginal
and the rule could surprise a future reader.

### 3c. (MEDIUM) Parent age band 42–63 is a precision choice, not a truth set

**Where it shows up.** `build_households.py:123` and the SQL tier rule.

**Why it's brittle.** Class of 2026 kids were born in 2008. Typical
parent age at first birth is 25–35 → today 43–53. The 42–63 band already
extends +10 years to capture older parents and grandparents-as-guardians,
but excludes very young parents (under-25 at birth) and miss-by-one
edge cases (a 41-year-old parent, a 64-year-old guardian). Per peer
review, this is fine for the *strict* T2; if the user finds T2b too
narrow later, widening to 38–67 in T2b only would let the strict tier
keep its precision.

### 3d. (MEDIUM) "Datazapp College-Bound" is not provably calibrated to ages 16–18

Datazapp publicly markets parent lists targeting "College-Bound Senior age"
(<https://www.datazapp.com/parents-mailing-lists>) but the imported file
itself does not stamp each row with the kid's actual age. T1 ∩ Datazapp
overlap was 94/180 — DZ catches roughly half the voter-confirmed seniors,
which suggests precision is OK but recall is finite. Treat DZ as a useful
vendor signal, not as ground truth.

### 3e. (LOW) Market value freshness — currently anchored on the 2023 triennial

Summit County's most recent countywide reappraisal cycle:

- **2020** sexennial (full reappraisal)
- **2023** triennial update (last shipped to public records)
- **2026** sexennial (the next full reappraisal — values "coming" per
  the iasWorld notice on every parcel detail page)

So the dollar values in `parcels.market_value` reflect 2023-effective
data. Hudson home prices have appreciated meaningfully since 2023, but
the **relative ordering** within Hudson is largely preserved — and the
SQL ranking already uses Hudson-only `percentile_cont(0.50/0.75)` (see
migration `_010` lines 17–21), so the percentile-based scoring is robust
to the absolute-dollar drift.

**To refresh anyway**, re-run `python scripts/load_parcels.py`. The
ArcGIS REST endpoint surfaces whatever the Fiscal Office has currently
posted. The 2026 reappraisal mailers are noted but not yet live in the
public data.

**Stretch:** add a `market_value_pct_hudson` precomputed column so
ranking is stable through future reassessments. Not shipped — the
in-query percentile already does the same thing; storing it is a
denormalization for performance, not correctness.

### 3f. (LOW) Address-key normalisation drift

I verified via Codex's data probes that voter, Datazapp, and parcel
loaders all use the same `address_key()` normaliser
(`scripts/address_key.py:69-124`), and that 1,283 of 1,558 unique DZ
addresses (82%) match at least one voter address. The 18% miss rate is
plausibly explained by apartment-unit parcels and a handful of post-box
mailings; it is *not* a systematic normalisation bug.

## 4. Things to fact-check before tuning further

1. **Pull voter records for the Peninsula 44264 ZIP** and any other
   precincts the Hudson City School District actually feeds. If the
   class-of-2026 universe grows by even 10–15 households, that's
   meaningful for door-knock targeting.
2. **Manually verify a handful of T2b leads** (the file `data/null_tenure_parcels.csv`
   produced by `scripts/export_null_tenure.py` is one input; pulling
   `WHERE tier='T2b' ORDER BY evidence_score DESC LIMIT 30` is another).
   If 5–10% turn out to actually have a senior, the tier is calibrated
   correctly. If it's <2%, T2b is too loose and should require
   `adult_45_58_count >= 2 AND years_owned >= 12` — that count was 146,
   a tighter recall floor.
3. **Look at the 343 "surname mismatch" households** (`tier IN ('T1','T2','T2b')
   AND owner_voter_surname_match IS FALSE`). A real mismatch suggests
   the parcel owner is not a resident — usually a parent is the title-
   holder for a college-age child, or a trust/LLC owns the home. These
   should not be excluded but should be inspected for false negatives in
   the regex used for surname extraction.
4. **Run `mcp__supabase__get_advisors type=performance`** after the
   migration. The new `owner_voter_surname_match` column has no index;
   if filtering on it becomes common, add `CREATE INDEX … (tier,
   owner_voter_surname_match)`.

## 5. Alternatives considered and rejected

| Option | Why rejected |
|---|---|
| Disjunctive T2 (`DZ OR voter-pattern`) | Mixes high-precision and inferred leads; user can't separate calibration. Both peers rejected. |
| Treat `years_owned IS NULL` as ≥ 8 | Only 0 households gain T2 status, 4 gain T2b. Pretends unknown = old. Codex pushed back. |
| Drop tenure floor to ≥ 5 | Doesn't help where `years_owned IS NULL`; simply adds noise to T2 by including recent buyers (who are unlikely to have HS seniors). |
| Hard-gate T2b on `owner_voter_surname_match = TRUE` | Loses ~13 valid T2b leads with maiden/married/trust mismatches; brittle. Used as scoring instead. |
| Add T2b to default-visible tiers | Inflates the door-knock list above the class-size ceiling (180+476+543=1,199 vs. 343 actual seniors). Made opt-in. |
| Backfill `years_owned` from `year_built` proxy | Only 4 new T2b leads. Marginal; adds rule the future maintainer must remember. Documented as an option above. |
| Browser-scrape all 573 NULL-tenure parcels | Sales data also missing in iasWorld for the cases I sampled. Manual scraping ~250 residential parcels would cost hours for ~6 incremental T2b leads. Not worth it. |

## 6. Operational artifacts shipped

- `supabase/migrations/20260430_012_t2b_voter_inferred_and_surname_match.sql` — the migration.
- `scripts/build_households.py` — `surname_key` bug fixed; `owner_voter_surname_match` populated on every rebuild so the manual SQL update isn't required after re-loading parcels.
- `scripts/export_null_tenure.py` — pulls the 573 NULL-tenure parcels, prioritises by signal density, writes `data/null_tenure_parcels.csv` with a `summit_lookup_url` column for one-click manual review of the worth-it residential rows.
- `site/index.html`, `site/styles.css`, `site/app.js` — T2b filter checkbox, marker styling (desaturated burnt orange), tier label, tier rule explainer, default-off filter state.
- This doc.

## 7. How to use the new tier

1. Default load shows T1 + T2 (180 + 476 = 656 households). No regression.
2. To add the inferred tier, tick "T2b — Likely senior (voter pattern only, no DZ)" in the Filters sidebar.
3. Sort by `evidence_score` to put highest-corroboration T2b leads first; surname-match is +6 there.
4. The drawer's tier rule explains *why* each household qualifies, including the new "Voter-pattern inferred…" sentence for T2b rows.

## 8. Known issues / known limits

- The 343 mismatched-surname households are not down-tiered, only score-penalised by 3 points. If the user finds many "wrong-house" knocks among them, switch the penalty to a hard exclusion for T2b only.
- T2b scoring does not currently weight `owner_voter_surname_match = TRUE` more heavily for inferred tiers than for confirmed tiers. If precision-recall data accumulates after the campaign, consider boosting it from +6 to +12 inside T2b only.
- The 2026 reappraisal is "noticed but not yet live" per iasWorld's
  parcel detail pages. Re-run `load_parcels.py` once the new values land
  to refresh raw `market_value`. Percentile-based scoring is unaffected.
