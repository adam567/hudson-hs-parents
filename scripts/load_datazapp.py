#!/usr/bin/env python3
"""Load Datazapp College-Bound Senior CSV into datazapp_imports.

Usage:
    python scripts/load_datazapp.py "C:/realestate/GIKIRW.csv" --label spring2026

Reads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from env.
"""
from __future__ import annotations

import argparse
import csv
import os
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from address_key import address_key
from supabase_client import require_env, upsert, truncate


def to_row(r: dict, batch_label: str) -> dict | None:
    city = (r.get("City") or r.get("CITY") or "").strip()
    state = (r.get("State") or r.get("STATE") or "").strip()
    zip5 = (r.get("Zip") or r.get("ZIP") or "").strip()
    addr = (r.get("Address") or r.get("ADDRESS") or "").strip()
    if not addr:
        return None
    apt = (r.get("Address2") or r.get("ADDRESS2") or "").strip()

    ak_full = addr if not apt else f"{addr} {apt}"
    ak = address_key(full_address=ak_full)
    if not ak:
        return None

    return {
        "batch_label": batch_label,
        "first_name": (r.get("FirstName") or r.get("FIRSTNAME") or "").strip() or None,
        "last_name": (r.get("LastName") or r.get("LASTNAME") or "").strip() or None,
        "address": addr or None,
        "address2": apt or None,
        "city": city.title() or None,
        "state": state.upper() or None,
        "zip": zip5 or None,
        "zip4": (r.get("Z4") or r.get("ZIP4") or "").strip() or None,
        "gender": (r.get("GENDER") or r.get("Gender") or "").strip().upper() or None,
        "address_key": ak,
        "imported_at": datetime.utcnow().isoformat() + "Z",
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("path", help="Path to Datazapp CSV")
    ap.add_argument("--label", default="spring2026", help="batch label")
    args = ap.parse_args()

    require_env()
    rows: list[dict] = []
    with open(args.path, "r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        for raw in reader:
            r = to_row(raw, args.label)
            if r:
                rows.append(r)

    if not rows:
        sys.exit("no Datazapp rows; refusing to write empty dataset")

    print(f"[datazapp] {len(rows)} rows from {args.path}")

    # Replace any prior batch with this label.
    truncate("datazapp_imports", where_param=f"batch_label=eq.{args.label}")
    print(f"[datazapp] cleared previous batch {args.label}")

    upsert("datazapp_imports", rows, batch_size=500)
    print(f"[datazapp] inserted {len(rows)} rows under label {args.label}")


if __name__ == "__main__":
    main()
