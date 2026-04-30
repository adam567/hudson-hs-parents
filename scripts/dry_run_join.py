#!/usr/bin/env python3
"""Run the voter+Datazapp join locally against the on-disk CSVs.

No Supabase, no parcel data. Sanity-checks the address-key normalization,
the senior-voter detection, and the Datazapp overlap before deployment.

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

VOTER_PATH = r"C:\realestate\VoterRolls\voterfile (1).csv"
DATAZAPP_PATH = r"C:\realestate\GIKIRW.csv"
ANCHOR = date(2026, 5, 1)


def age_at(by: int | None, anchor: date) -> int | None:
    if not by:
        return None
    return anchor.year - by - (1 if (anchor.month, anchor.day) < (6, 30) else 0)


def main() -> None:
    voters_by_addr: dict[str, list[dict]] = defaultdict(list)
    voter_n = 0
    with open(VOTER_PATH, "r", encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            if (r.get("CITY") or "").strip().upper() != "HUDSON":
                continue
            if (r.get("ZIP") or "").strip() != "44236":
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
            })
            voter_n += 1

    print(f"voter rows in 44236 Hudson: {voter_n}")
    print(f"voter unique addresses:    {len(voters_by_addr)}")

    datazapp_by_addr: dict[str, list[dict]] = defaultdict(list)
    dz_n = 0
    with open(DATAZAPP_PATH, "r", encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            ak = address_key(full_address=(r.get("Address") or "").strip())
            if not ak:
                continue
            datazapp_by_addr[ak].append({"first": r.get("FirstName"), "last": r.get("LastName")})
            dz_n += 1

    print(f"datazapp rows: {dz_n}")
    print(f"datazapp unique addresses: {len(datazapp_by_addr)}")

    # Tier rollup
    tiers = Counter()
    senior_addrs = []
    for ak in set(voters_by_addr) | set(datazapp_by_addr):
        vs = voters_by_addr.get(ak, [])
        ds = datazapp_by_addr.get(ak, [])
        ages = [age_at(v["birth_year"], ANCHOR) for v in vs]
        ages = [a for a in ages if a is not None]
        c_17_18 = sum(1 for a in ages if a in (17, 18))
        c_19_20 = sum(1 for a in ages if a in (19, 20))
        adult_count = sum(1 for a in ages if a >= 21)
        adult_42_63 = sum(1 for a in ages if 42 <= a <= 63)
        if c_17_18 > 0:
            tiers["T1"] += 1
            senior_addrs.append(ak)
        elif c_19_20 > 0:
            tiers["T2"] += 1
        elif ds and adult_42_63 >= 2:
            tiers["T3"] += 1
        elif ds and adult_42_63 >= 1:
            tiers["T4"] += 1
        elif ds:
            tiers["T5"] += 1
        else:
            tiers["TX"] += 1

    print()
    print("tier counts (voter+Datazapp universe, no parcel join):")
    for t in ("T1", "T2", "T3", "T4", "T5", "TX"):
        print(f"  {t}: {tiers[t]}")

    # Datazapp ↔ voter T1 overlap
    voter_t1 = set(senior_addrs)
    dz_addrs = set(datazapp_by_addr.keys())
    overlap = voter_t1 & dz_addrs
    print(f"\nT1 voter-confirmed senior addresses: {len(voter_t1)}")
    print(f"Datazapp addresses:                  {len(dz_addrs)}")
    print(f"T1 AND Datazapp overlap:             {len(overlap)}")


if __name__ == "__main__":
    main()
