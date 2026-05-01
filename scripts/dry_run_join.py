#!/usr/bin/env python3
"""Run the voter-only join locally against the on-disk CSV.

No Supabase, no parcel data. Sanity-checks the address-key normalization
and the senior-voter detection before deployment. Tier counts here are an
approximation of the SQL logic — without parcel data we cannot apply the
T2 owner-occupied / years-owned / non-institutional gates, so T2 here is
the upper bound (any address with two parent-age adults).

Usage:
    python scripts/dry_run_join.py
"""
from __future__ import annotations

import csv
import os
import sys
from datetime import date
from collections import Counter, defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from address_key import address_key

VOTER_PATHS = [
    r"C:\realestate\VoterRolls\hudson - voter file.csv",
    r"C:\realestate\VoterRolls\peninsula - voter file.csv",
]
ANCHOR = date(2026, 5, 1)
TARGET_CITIES = {"HUDSON", "PENINSULA"}
TARGET_ZIPS = {"44236", "44264"}


def age_at(by: int | None, anchor: date) -> int | None:
    if not by:
        return None
    return anchor.year - by - (1 if (anchor.month, anchor.day) < (6, 30) else 0)


def main() -> None:
    voters_by_addr: dict[str, list[dict]] = defaultdict(list)
    voter_n = 0
    for voter_path in VOTER_PATHS:
        if not os.path.isfile(voter_path):
            print(f"[dry-run] missing voter file: {voter_path}", file=sys.stderr)
            continue
        with open(voter_path, "r", encoding="utf-8-sig", newline="") as f:
            for r in csv.DictReader(f):
                city = (r.get("CITY") or "").strip().upper()
                zip5 = (r.get("ZIP") or "").strip()
                if not any(city.startswith(c) for c in TARGET_CITIES):
                    continue
                if zip5 not in TARGET_ZIPS:
                    continue
                ak = address_key(
                    house_num=r.get("STNUM"),
                    direction=r.get("STDIR"),
                    street_name=r.get("STNAME"),
                    apt=r.get("APT"),
                )
                if not ak:
                    continue
                by = (r.get("BIRTHYEAR") or "").strip()
                voters_by_addr[ak].append({
                    "birth_year": int(by) if by.isdigit() else None,
                    "last_name": (r.get("LASTN") or "").strip().upper(),
                    "reg_date": (r.get("REGDATE") or "").strip(),
                    "city": city,
                    "zip": zip5,
                })
                voter_n += 1

    print(f"voter rows in target slice: {voter_n}")
    print(f"voter unique addresses:     {len(voters_by_addr)}")
    by_city = Counter(vs[0]["city"] for vs in voters_by_addr.values() if vs)
    print(f"unique addresses by city:   {dict(by_city)}")

    tiers = Counter()
    senior_addrs = []
    for ak, vs in voters_by_addr.items():
        ages = [age_at(v["birth_year"], ANCHOR) for v in vs]
        ages = [a for a in ages if a is not None]
        c_17_18 = sum(1 for a in ages if a in (17, 18))
        c_19_20 = sum(1 for a in ages if a in (19, 20))
        adult_42_63 = sum(1 for a in ages if 42 <= a <= 63)
        if c_17_18 > 0:
            tiers["T1"] += 1
            senior_addrs.append(ak)
        elif adult_42_63 >= 2:
            # Upper-bound for T2 — SQL further requires owner-occupancy,
            # 8+ years owned, non-institutional, and not absentee_or_rental.
            tiers["T2_upper_bound"] += 1
        elif c_19_20 > 0:
            tiers["T3"] += 1
        else:
            tiers["TX"] += 1

    print()
    print("tier counts (voter-only, no parcel join — T2 is an upper bound):")
    for t in ("T1", "T2_upper_bound", "T3", "TX"):
        print(f"  {t}: {tiers[t]}")
    print(f"\nT1 voter-confirmed senior addresses: {len(senior_addrs)}")


if __name__ == "__main__":
    main()
