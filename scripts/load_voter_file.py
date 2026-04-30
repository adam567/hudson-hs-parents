#!/usr/bin/env python3
"""Load Ohio voter file CSV into voter_records.

Source: Ohio Secretary of State daily voter snapshots. The CSV used here
filters to Hudson 44236.

Usage:
    python scripts/load_voter_file.py "C:/realestate/VoterRolls/voterfile (1).csv"

Reads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from env.
"""
from __future__ import annotations

import csv
import os
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from address_key import address_key
from supabase_client import require_env, upsert, truncate

TARGET_CITY = os.environ.get("TARGET_CITY", "HUDSON").upper()
TARGET_ZIPS = {z.strip() for z in os.environ.get("TARGET_ZIPS", "44236").split(",") if z.strip()}


def parse_reg_date(s: str) -> str | None:
    s = (s or "").strip()
    if not s or len(s) < 10:
        return None
    try:
        # MM/DD/YYYY
        return datetime.strptime(s[:10], "%m/%d/%Y").date().isoformat()
    except ValueError:
        return None


def to_row(r: dict) -> dict | None:
    city = (r.get("CITY") or "").strip().upper()
    zip5 = (r.get("ZIP") or "").strip()
    if not city.startswith(TARGET_CITY):
        return None
    if zip5 not in TARGET_ZIPS:
        return None

    house_num = (r.get("STNUM") or "").strip()
    direction = (r.get("STDIR") or "").strip()
    street = (r.get("STNAME") or "").strip()
    apt = (r.get("APT") or "").strip()
    ak = address_key(house_num=house_num, direction=direction, street_name=street, apt=apt)
    if not ak:
        return None

    by_raw = (r.get("BIRTHYEAR") or "").strip()
    birth_year = int(by_raw) if by_raw.isdigit() else None

    return {
        "county_id": (r.get("CNTYIDNUM") or "").strip() or None,
        "sos_id": (r.get("SOSIDNUM") or "").strip() or None,
        "first_name": (r.get("FIRSTN") or "").strip() or None,
        "last_name": (r.get("LASTN") or "").strip() or None,
        "middle_name": (r.get("MIDDLEN") or "").strip() or None,
        "birth_year": birth_year,
        "reg_date": parse_reg_date(r.get("REGDATE") or ""),
        "voter_status": (r.get("VOTERSTAT") or "").strip() or None,
        "party": (r.get("PARTYAFFIL") or "").strip() or None,
        "precinct": (r.get("PRECNAME") or "").strip() or None,
        "res_address": " ".join([p for p in [house_num, direction, street, apt] if p]) or None,
        "res_city": city.title() or None,
        "res_zip": zip5 or None,
        "address_key": ak,
        "mailing_address": (r.get("MADDR1") or "").strip() or None,
        "mailing_city": (r.get("MCITY") or "").strip().upper() or None,
        "mailing_state": (r.get("MSTATE") or "").strip().upper() or None,
        "mailing_zip": (r.get("MZIP") or "").strip() or None,
        "refreshed_at": datetime.utcnow().isoformat() + "Z",
    }


def main(path: str) -> None:
    require_env()
    rows: list[dict] = []
    with open(path, "r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        for raw in reader:
            r = to_row(raw)
            if r:
                rows.append(r)

    if not rows:
        sys.exit("no voter rows passed filters; refusing to write empty dataset")

    print(f"[voter] {len(rows)} rows after Hudson 44236 filter")

    # Full-refresh strategy: wipe then upsert. Voter file is the spine; we
    # want a clean snapshot every load.
    truncate("voter_records", where_param="address_key=neq.__never__")
    print("[voter] cleared previous voter_records")

    # Upsert in batches.
    upsert("voter_records", rows, on_conflict="sos_id", batch_size=500)
    print(f"[voter] upserted {len(rows)} rows")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit("usage: load_voter_file.py <path/to/voterfile.csv>")
    main(sys.argv[1])
