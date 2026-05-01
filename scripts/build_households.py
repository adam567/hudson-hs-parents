#!/usr/bin/env python3
"""Build the households spine — one row per address_key, joined across
parcel + voter. Computes voter rollups (counts by age band, adult age
bands, surname-match flag). Then calls recompute_tiers() to assign tier +
evidence_score + chips + why_sentence.

Usage:
    python scripts/build_households.py [--anchor 2026-05-01]

Anchor date defaults to today; voter ages are derived from BIRTHYEAR + anchor.
"""
from __future__ import annotations

import argparse
import os
import sys
from datetime import date, datetime
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from supabase_client import require_env, request, upsert, call_rpc, truncate


def page_through(table: str, columns: str, where: str = "") -> list[dict]:
    """Fetch every row of a table via PostgREST pagination."""
    out: list[dict] = []
    offset = 0
    page = 1000
    while True:
        path = f"/{table}?select={columns}&limit={page}&offset={offset}"
        if where:
            path += f"&{where}"
        r = request("GET", path)
        chunk = r.json()
        if not chunk:
            break
        out.extend(chunk)
        if len(chunk) < page:
            break
        offset += page
    return out


def institutional(owner: str | None) -> bool:
    if not owner:
        return False
    s = owner.upper()
    return any(t in s for t in ("LLC", "TRUSTEE", "TRUST", "ATTN", "C/O",
                                 "ESQ", "INC", "CORP", "FOUNDATION", "BANK"))


LOCAL_ZIPS = {z.strip() for z in os.environ.get(
    "TARGET_ZIPS", "44236,44264").split(",") if z.strip()}


def out_of_hudson(parcel: dict) -> bool:
    same = parcel.get("mailing_same_as_situs")
    mzip = (parcel.get("mailing_zip") or "").strip()
    if same:
        return False
    if mzip in LOCAL_ZIPS:
        return False
    return bool(mzip)  # mailing zip exists and isn't a school-district ZIP


def age_at(birth_year: int | None, anchor: date) -> int | None:
    if not birth_year:
        return None
    return anchor.year - birth_year - (1 if (anchor.month, anchor.day) < (6, 30) else 0)


def display_name_from_owner(owner1: str | None, owner2: str | None) -> str:
    if not owner1:
        return "Unknown"
    return owner1.strip()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--anchor", default=None,
                    help="Campaign anchor date YYYY-MM-DD (default: today)")
    args = ap.parse_args()

    require_env()
    anchor = date.fromisoformat(args.anchor) if args.anchor else date.today()
    print(f"[households] anchor date: {anchor}")

    print("[households] loading parcels …")
    parcels = page_through("parcels",
        "id,county_parcel_id,address_key,situs_address,situs_city,situs_zip,"
        "mailing_address,mailing_city,mailing_zip,mailing_same_as_situs,"
        "sqft,market_value,year_built,owner1_raw,owner2_raw,lat,lng,source_payload")
    print(f"[households] {len(parcels)} parcels")

    print("[households] loading voter records …")
    voters = page_through("voter_records",
        "address_key,first_name,last_name,birth_year,reg_date")
    print(f"[households] {len(voters)} voter records")

    voters_by_addr: dict[str, list[dict]] = defaultdict(list)
    for v in voters:
        if v.get("address_key"):
            voters_by_addr[v["address_key"]].append(v)

    rows: list[dict] = []
    for p in parcels:
        ak = p["address_key"]
        vs = voters_by_addr.get(ak, [])

        ages = [age_at(v.get("birth_year"), anchor) for v in vs]
        ages = [a for a in ages if a is not None]

        count_17_18 = sum(1 for a in ages if a in (17, 18))
        count_19_20 = sum(1 for a in ages if a in (19, 20))
        adult_count = sum(1 for a in ages if a >= 21)
        adult_42_63 = sum(1 for a in ages if 42 <= a <= 63)
        adult_45_58 = sum(1 for a in ages if 45 <= a <= 58)
        # Launching-window band: an extra adult voter in this age range is
        # consistent with a recent grad / college sibling of a current senior.
        # 26+ skews to "kids fully launched / multi-generational" — used to
        # disqualify T2 since those households are not current-senior parents.
        adult_21_25 = sum(1 for a in ages if 21 <= a <= 25)
        adult_26plus = sum(1 for a in ages if a >= 26)
        # Oldest extra-adult voter (any adult outside the parent-age band).
        # Frontend uses this to let the user tighten the launching-window
        # cutoff (default 22) without re-running the migration.
        non_parent_extras = [a for a in ages if a >= 21 and not (42 <= a <= 63)]
        max_extra_age = max(non_parent_extras) if non_parent_extras else None

        # Same-surname youth-to-adult check
        youth_surnames = {(v.get("last_name") or "").strip().upper() for v in vs
                          if age_at(v.get("birth_year"), anchor) in (17, 18)}
        adult_surnames = {(v.get("last_name") or "").strip().upper() for v in vs
                          if (age_at(v.get("birth_year"), anchor) or 0) >= 30}
        same_surname = bool(youth_surnames & adult_surnames)

        senior_dates = [v.get("reg_date") for v in vs
                        if age_at(v.get("birth_year"), anchor) in (17, 18)
                        and v.get("reg_date")]
        senior_reg_min = min(senior_dates) if senior_dates else None

        oldest_by = min((v.get("birth_year") for v in vs if v.get("birth_year")), default=None)
        youngest_by = max((v.get("birth_year") for v in vs if v.get("birth_year")), default=None)

        # Years owned: pulled from source_payload (computed in load_parcels).
        sp = p.get("source_payload") or {}
        years_owned = sp.get("years_owned") if isinstance(sp, dict) else None
        institutional_flag = sp.get("institutional_owner") if isinstance(sp, dict) else False

        owner_names = [n for n in [p.get("owner1_raw"), p.get("owner2_raw")] if n]

        # Owner surname is the FIRST whitespace-token of owner1_raw — the Summit
        # County parcel format is "LASTNAME FIRSTNAME [MIDDLE]". The previous
        # implementation took split()[-1] which yielded the middle initial, "JR",
        # or "LLC" instead of the surname.
        owner_first_token = (p.get("owner1_raw") or "").split()[0].upper() if p.get("owner1_raw") else None
        voter_surnames = {(v.get("last_name") or "").strip().upper() for v in vs if v.get("last_name")}
        owner_surname_match = (
            None if not owner_first_token or not voter_surnames
            else (owner_first_token in voter_surnames)
        )
        rows.append({
            "address_key": ak,
            "parcel_id": p["id"],
            "display_name": display_name_from_owner(p.get("owner1_raw"), p.get("owner2_raw")),
            "surname_key": owner_first_token,
            "owner_voter_surname_match": owner_surname_match,
            "owner_names": owner_names,
            "situs_address": p.get("situs_address"),
            "situs_city": p.get("situs_city"),
            "situs_zip": p.get("situs_zip"),
            "lat": p.get("lat"),
            "lng": p.get("lng"),
            "market_value": p.get("market_value"),
            "sqft": p.get("sqft"),
            "year_built": p.get("year_built"),
            "years_owned": years_owned,
            "mailing_same_as_situs": p.get("mailing_same_as_situs"),
            "parcel_owner_occupied_local": p.get("mailing_same_as_situs"),
            "voter_count": len(vs),
            "has_17_18_voter": count_17_18 > 0,
            "count_17_18_voters": count_17_18,
            "has_19_20_voter": count_19_20 > 0,
            "count_19_20_voters": count_19_20,
            "youngest_voter_birth_year": youngest_by,
            "oldest_voter_birth_year": oldest_by,
            "adult_42_63_count": adult_42_63,
            "adult_45_58_count": adult_45_58,
            "adult_21_25_count": adult_21_25,
            "adult_26plus_count": adult_26plus,
            "max_non_parent_adult_age": max_extra_age,
            "adult_count": adult_count,
            "same_surname_youth_to_adult": same_surname,
            "senior_reg_date_min": senior_reg_min,
            "institutional_owner": institutional_flag,
            "out_of_hudson_mailing": out_of_hudson(p),
            "refreshed_at": datetime.utcnow().isoformat() + "Z",
        })

    if not rows:
        sys.exit("no households built; refusing to wipe")

    # Dedupe by address_key — multi-parcel addresses (condos, multi-unit, lot
    # splits) collide on the unique address_key index. Keep the parcel with the
    # highest market_value as the primary; voter counts are address-keyed so
    # they're identical across the dropped duplicates.
    by_ak: dict[str, dict] = {}
    for r in rows:
        existing = by_ak.get(r["address_key"])
        if existing is None or (r.get("market_value") or 0) > (existing.get("market_value") or 0):
            by_ak[r["address_key"]] = r
    deduped = list(by_ak.values())
    if len(deduped) < len(rows):
        print(f"[households] deduped {len(rows) - len(deduped)} multi-parcel collisions "
              f"-> {len(deduped)} unique address_keys")
    rows = deduped

    print(f"[households] computed {len(rows)} household rows")

    truncate("households")
    print("[households] cleared previous households")

    upsert("households", rows, on_conflict="address_key", batch_size=500)
    print("[households] upserted households")

    # Tier + evidence + why-sentence in SQL
    call_rpc("recompute_tiers", {"anchor": anchor.isoformat()})
    print("[households] recompute_tiers done")

    # Quick stats
    counts = page_through("households", "tier")
    from collections import Counter
    by_tier = Counter(c.get("tier") for c in counts)
    print(f"[households] tier counts: {dict(by_tier)}")


if __name__ == "__main__":
    main()
