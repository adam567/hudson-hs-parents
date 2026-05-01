#!/usr/bin/env python3
"""Export the parcels with NULL years_owned to an Excel-friendly CSV.

The output is sorted so the residential, household-relevant rows show up
first — schools, parks, churches, and HOA common-area parcels go to the
bottom. Drop the CSV into Excel, double-click the high-priority rows, and
look up each county_parcel_id at fiscaloffice.summitoh.net to recover a
sale date / current market value where the SC706 export omitted it.

Output: data/null_tenure_parcels.csv
"""
from __future__ import annotations

import csv
import os
import sys
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from supabase_client import require_env, request


SUMMIT_LOOKUP_URL_TEMPLATE = "https://fiscaloffice.summitoh.net/index.php/property-search?parcel={parcel_id}"


def _is_institutional(owner: str) -> bool:
    s = (owner or "").upper()
    return any(t in s for t in (
        "TRUSTEES", "BOARD OF", "VILLAGE OF", "CITY OF", "TOWNSHIP",
        "BD OF", "SCHOOL DIST", "RESERVE ACADEMY", "PARK COMMISS",
        "HOMEOWNERS", "CHURCH", "PRESBYTERIAN", "LUTHERAN", "CONGREGATIONAL",
        "BISHOP", "USA", "LLC", "INC", "CORP", "LP", "LTD", "TRUST",
        "ASSOCIATION", "ASSOC", "COMMUNITY", "DEVELOPMENT CO",
        "CONDOMINIUM", "PROPERTIES", "RETIREMENT",
    ))


def _is_likely_residential(row: dict) -> bool:
    """Heuristic: parcel has a street number (not a vacant-lot road name only),
    has a year_built, and is not institutional."""
    addr = (row.get("address") or "").strip()
    has_street_num = bool(addr) and addr[0].isdigit()
    return (
        has_street_num
        and row.get("built") is not None
        and not _is_institutional(row.get("owner1") or "")
    )


def _priority(row: dict) -> int:
    """Lower number = higher priority for manual lookup."""
    if row.get("has_17_18_voter"):
        return 0  # T1 candidate, urgent
    if (row.get("adult_42_63_count") or 0) >= 2 and _is_likely_residential(row):
        return 1  # voter-pattern T2 candidate
    if _is_likely_residential(row) and row.get("owner_occ"):
        return 2  # residential owner-occupied
    if _is_likely_residential(row):
        return 3  # residential other
    if _is_institutional(row.get("owner1") or ""):
        return 9  # public/HOA — skip
    return 4  # vacant land or other


def fetch_null_parcels() -> list[dict[str, Any]]:
    """Pull every parcel with NULL years_owned, joined with household-level
    signals where present. Uses PostgREST pagination."""
    rows: list[dict[str, Any]] = []
    offset = 0
    page = 1000
    while True:
        path = (
            f"/parcels?select="
            f"county_parcel_id,situs_address,situs_zip,owner1_raw,owner2_raw,"
            f"market_value,year_built,sqft,mailing_zip,mailing_same_as_situs,"
            f"source_payload"
            f"&source_payload->>years_owned=is.null"
            f"&order=market_value.desc.nullslast"
            f"&limit={page}&offset={offset}"
        )
        r = request("GET", path)
        chunk = r.json()
        if not chunk:
            break
        rows.extend(chunk)
        if len(chunk) < page:
            break
        offset += page
    return rows


def fetch_household_signals() -> dict[str, dict]:
    """Map address_key → {tier, has_17_18_voter, adult_42_63_count}."""
    out: dict[str, dict] = {}
    offset = 0
    page = 1000
    while True:
        path = (
            f"/households?select=address_key,tier,has_17_18_voter,"
            f"adult_42_63_count&limit={page}&offset={offset}"
        )
        r = request("GET", path)
        chunk = r.json()
        if not chunk:
            break
        for h in chunk:
            out[h["address_key"]] = h
        if len(chunk) < page:
            break
        offset += page
    return out


def fetch_address_keys() -> dict[str, str]:
    """Map county_parcel_id → address_key."""
    out: dict[str, str] = {}
    offset = 0
    page = 1000
    while True:
        path = f"/parcels?select=county_parcel_id,address_key&limit={page}&offset={offset}"
        r = request("GET", path)
        chunk = r.json()
        if not chunk:
            break
        for p in chunk:
            out[p["county_parcel_id"]] = p["address_key"]
        if len(chunk) < page:
            break
        offset += page
    return out


def main() -> None:
    require_env()
    print("[null_tenure] fetching parcels …")
    parcels = fetch_null_parcels()
    print(f"[null_tenure] {len(parcels)} parcels with NULL years_owned")

    print("[null_tenure] fetching household signals …")
    households = fetch_household_signals()
    parcel_to_addr = fetch_address_keys()

    enriched: list[dict] = []
    for p in parcels:
        ak = parcel_to_addr.get(p["county_parcel_id"], "")
        h = households.get(ak, {})
        row = {
            "parcel_id":          p.get("county_parcel_id") or "",
            "address":            p.get("situs_address") or "",
            "zip":                p.get("situs_zip") or "",
            "owner1":             p.get("owner1_raw") or "",
            "owner2":             p.get("owner2_raw") or "",
            "market_value":       p.get("market_value"),
            "year_built":         p.get("year_built"),
            "sqft":               p.get("sqft"),
            "owner_occ":          p.get("mailing_same_as_situs"),
            "tier":               h.get("tier", ""),
            "has_17_18_voter":    h.get("has_17_18_voter", False),
            "adult_42_63_count":  h.get("adult_42_63_count", 0),
            "summit_lookup_url":  SUMMIT_LOOKUP_URL_TEMPLATE.format(parcel_id=p.get("county_parcel_id") or ""),
        }
        row["priority"] = _priority(row)
        enriched.append(row)

    enriched.sort(key=lambda r: (r["priority"], -(r["market_value"] or 0)))

    out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data")
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.abspath(os.path.join(out_dir, "null_tenure_parcels.csv"))

    fieldnames = [
        "priority", "tier", "parcel_id", "address", "zip",
        "owner1", "owner2", "market_value", "year_built", "sqft",
        "owner_occ", "has_17_18_voter", "adult_42_63_count",
        "summit_lookup_url",
    ]
    with open(out_path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        for r in enriched:
            w.writerow(r)

    by_priority: dict[int, int] = {}
    for r in enriched:
        by_priority[r["priority"]] = by_priority.get(r["priority"], 0) + 1
    print(f"[null_tenure] wrote {out_path}")
    print("[null_tenure] priority distribution:")
    labels = {
        0: "0 — has 17/18-yo voter (T1 candidate)",
        1: "1 — voter-pattern T2 candidate",
        2: "2 — residential owner-occupied",
        3: "3 — residential other",
        4: "4 — vacant / other",
        9: "9 — institutional (public, HOA, school, church)",
    }
    for k in sorted(by_priority):
        print(f"  {labels.get(k, k)}: {by_priority[k]}")


if __name__ == "__main__":
    main()
