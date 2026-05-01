#!/usr/bin/env python3
"""Load Ohio voter file CSV(s) into voter_records.

Source: Ohio Secretary of State daily voter snapshots. Pass one or more
exports; each is filtered to the configured (CITY, ZIP) pairs and merged.

Hudson High School District is NOT identical to ZIP 44236 — pieces of
Peninsula 44264 (and historically Boston Heights) are in HCSD too. Pass
those exports as additional positional args and override TARGET_CITIES /
TARGET_ZIPS to widen the filter.

Usage:
    python scripts/load_voter_file.py \\
        "C:/realestate/VoterRolls/voterfile (1).csv" \\
        "C:/realestate/VoterRolls/peninsula - voter file.csv" \\
        "C:/realestate/VoterRolls/boston heights - voter file.csv"

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

# Comma-separated lists; default covers Hudson + Peninsula. Boston Heights
# voters carry CITY=HUDSON ZIP=44236 in the SOS export (USPS post office
# is Hudson) so they're already accepted by the Hudson 44236 filter.
TARGET_CITIES = {c.strip().upper() for c in os.environ.get(
    "TARGET_CITIES", "HUDSON,PENINSULA").split(",") if c.strip()}
TARGET_ZIPS = {z.strip() for z in os.environ.get(
    "TARGET_ZIPS", "44236,44264").split(",") if z.strip()}


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
    if not any(city.startswith(c) for c in TARGET_CITIES):
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


def main(paths: list[str]) -> None:
    require_env()
    rows: list[dict] = []
    seen_sos_ids: set[str] = set()
    per_file_counts: list[tuple[str, int, int]] = []
    for path in paths:
        kept = 0
        seen = 0
        with open(path, "r", encoding="utf-8-sig", newline="") as f:
            reader = csv.DictReader(f)
            for raw in reader:
                seen += 1
                r = to_row(raw)
                if not r:
                    continue
                sos = r.get("sos_id")
                # Voter could appear in multiple files (rare — each county/precinct
                # roster is normally exclusive — but Hudson + Peninsula could
                # overlap on township-line precincts). Dedupe by SOS id.
                if sos and sos in seen_sos_ids:
                    continue
                if sos:
                    seen_sos_ids.add(sos)
                rows.append(r)
                kept += 1
        per_file_counts.append((path, seen, kept))

    if not rows:
        sys.exit("no voter rows passed filters; refusing to write empty dataset")

    for path, seen, kept in per_file_counts:
        print(f"[voter] {os.path.basename(path)}: {kept}/{seen} rows kept")
    print(f"[voter] {len(rows)} unique rows after dedupe; "
          f"cities={sorted(TARGET_CITIES)} zips={sorted(TARGET_ZIPS)}")

    # Full-refresh strategy: wipe then upsert. Voter file is the spine; we
    # want a clean snapshot every load.
    truncate("voter_records", where_param="address_key=neq.__never__")
    print("[voter] cleared previous voter_records")

    # Upsert in batches.
    upsert("voter_records", rows, on_conflict="sos_id", batch_size=500)
    print(f"[voter] upserted {len(rows)} rows")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit("usage: load_voter_file.py <path/to/voterfile.csv> [more.csv ...]")
    main(sys.argv[1:])
