#!/usr/bin/env python3
"""Pull Hudson 44236 parcel data from Summit County ArcGIS REST + SC706_SALES.

Difference from the hudson-leads parcel script:
  - No sqft floor filter (universe is the whole owner-occupied 44236 set)
  - Includes absentee owners (we mark them so the UI can scrub door-knock-only)
  - Computes address_key for every parcel
  - Stores both situs and mailing components separately so the door-knock
    scrub can run in SQL.
"""
from __future__ import annotations

import csv
import io
import json
import os
import sys
import time
import zipfile
from datetime import date, datetime
from typing import Iterable

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from address_key import address_key
from supabase_client import require_env, upsert, truncate


FEATURE_SERVER = (os.environ.get("FEATURE_SERVER") or
    "https://scgis.summitoh.net/hosted/rest/services/parcels_web_GEODATA_Tax_Parcels/FeatureServer/0"
).rstrip("/")
SALES_ZIP_URL = (os.environ.get("SALES_ZIP_URL") or
    "https://fiscaloffice.summitoh.net/index.php/documents-a-forms/finish/10-cama/237-sc706sales"
)
TARGET_ZIPS = [z.strip() for z in os.environ.get("TARGET_ZIPS", "44236,44264").split(",") if z.strip()]
# Default broadens to the cities served by Hudson City School District. Set
# TARGET_CITY explicitly to override (e.g. "HUDSON" only) for narrower runs.
TARGET_CITIES = [c.strip().upper() for c in os.environ.get(
    "TARGET_CITIES", os.environ.get("TARGET_CITY", "HUDSON,PENINSULA")).split(",") if c.strip()]
TARGET_CITY = TARGET_CITIES[0]  # back-compat for legacy log line

F = {
    "zip":         os.environ.get("ZIP_FIELD", "pstlzip5"),
    "city":        os.environ.get("CITY_FIELD", "pstlcity"),
    "addr":        os.environ.get("ADDR_FIELD", "siteaddress"),
    "mail":        os.environ.get("MAIL_FIELD", "pstladdress"),
    "owner":       os.environ.get("OWNER_FIELD", "ownernme1"),
    "owner2":      os.environ.get("OWNER2_FIELD", "ownernme2"),
    "sqft":        os.environ.get("SQFT_FIELD", "resflrarea"),
    "value":       os.environ.get("VALUE_FIELD", "cntmarval"),
    "year_built":  os.environ.get("YEAR_BUILT_FIELD", "resyrblt"),
    "class":       os.environ.get("CLASS_FIELD", "classdscrp"),
    "parcel_id":   os.environ.get("PARCEL_ID_FIELD", "parcelid"),
    "mailcity":    os.environ.get("MAIL_CITY_FIELD", "pstlcity"),
    "mailzip":     os.environ.get("MAIL_ZIP_FIELD", "pstlzip5"),
}

INSTITUTIONAL_RX_TOKENS = ("LLC", "TRUSTEE", "TRUST", "ATTN", "C/O", "ESQ",
                          "INC", "CORP", "FOUNDATION", "BANK")


def institutional_owner(owner: str | None) -> bool:
    if not owner:
        return False
    s = owner.upper()
    return any(t in s for t in INSTITUTIONAL_RX_TOKENS)


def normalize_simple(s: str | None) -> str:
    if not s:
        return ""
    return " ".join(s.split()).upper().rstrip(", ")


def polygon_centroid(geom: dict | None):
    if not geom:
        return None, None
    rings = geom.get("rings") or []
    if not rings or not rings[0]:
        return None, None
    xs = [pt[0] for pt in rings[0]]
    ys = [pt[1] for pt in rings[0]]
    return sum(xs) / len(xs), sum(ys) / len(ys)


def fetch_arcgis(zip_code: str) -> Iterable[dict]:
    out_fields = [v for v in [F["parcel_id"], F["addr"], F["city"], F["zip"], F["mail"],
                              F["owner"], F["owner2"], F["sqft"], F["value"],
                              F["year_built"], F["class"]] if v]
    city_clauses = " OR ".join(f"{F['city']} LIKE '{c}%'" for c in TARGET_CITIES)
    where = f"{F['zip']}='{zip_code}' AND ({city_clauses})"
    offset = 0
    page = 1000
    while True:
        params = {
            "where": where, "outFields": ",".join(out_fields),
            "returnGeometry": "true", "outSR": 4326, "f": "json",
            "resultOffset": offset, "resultRecordCount": page,
        }
        r = requests.get(f"{FEATURE_SERVER}/query", params=params, timeout=60)
        r.raise_for_status()
        data = r.json()
        if "error" in data:
            sys.exit(f"arcgis error: {data['error']}")
        feats = data.get("features", []) or []
        if not feats:
            return
        for feat in feats:
            attrs = dict(feat.get("attributes", {}))
            lng, lat = polygon_centroid(feat.get("geometry"))
            attrs["__lat"] = lat
            attrs["__lng"] = lng
            yield attrs
        if not data.get("exceededTransferLimit") and len(feats) < page:
            return
        offset += len(feats)
        time.sleep(0.2)


def fetch_sales_index() -> dict[str, dict]:
    print(f"[sales] downloading {SALES_ZIP_URL}")
    sess = requests.Session()
    sess.headers["User-Agent"] = "Mozilla/5.0 (hudson-hs-parents)"
    sess.get("https://fiscaloffice.summitoh.net/", timeout=30)
    r = sess.get(SALES_ZIP_URL, timeout=180)
    r.raise_for_status()
    print(f"[sales] {len(r.content)//1024} KB downloaded")
    z = zipfile.ZipFile(io.BytesIO(r.content))
    csv_name = next(n for n in z.namelist() if n.upper().endswith(".CSV"))
    latest: dict[str, dict] = {}
    rows = 0
    with z.open(csv_name) as raw:
        text = io.TextIOWrapper(raw, encoding="latin-1", newline="")
        for row in csv.DictReader(text):
            rows += 1
            pid = (row.get("PARCEL") or "").strip()
            date_s = (row.get("SALEDATE") or "").strip()
            if not pid or not date_s:
                continue
            try:
                dt = datetime.strptime(date_s, "%d-%b-%Y").date()
            except ValueError:
                continue
            existing = latest.get(pid)
            if not existing or dt > existing["sale_date"]:
                price_s = (row.get("PRICE") or "").strip()
                try:
                    price = int(price_s) if price_s else None
                except ValueError:
                    price = None
                latest[pid] = {"sale_date": dt, "sale_price": price}
    print(f"[sales] parsed {rows} rows; {len(latest)} parcels with dated sales")
    return latest


def years_owned(d: date | None) -> int | None:
    if not d:
        return None
    today = date.today()
    yrs = today.year - d.year - ((today.month, today.day) < (d.month, d.day))
    return max(0, yrs)


def to_row(attrs: dict, sales: dict[str, dict]) -> dict | None:
    parcel_id = str(attrs.get(F["parcel_id"]) or "").strip()
    if not parcel_id:
        return None

    site_raw = (attrs.get(F["addr"]) or "").strip() or None
    mail_raw = (attrs.get(F["mail"]) or "").strip() or None
    site_norm = normalize_simple(site_raw)
    mail_norm = normalize_simple(mail_raw)
    same = bool(site_norm and mail_norm and site_norm == mail_norm)

    ak = address_key(full_address=site_raw or "") if site_raw else ""
    if not ak:
        return None

    sale = sales.get(parcel_id) or {}
    sale_date: date | None = sale.get("sale_date")

    return {
        "county_parcel_id": parcel_id,
        "address_key": ak,
        "situs_address": site_raw,
        "situs_city": (attrs.get(F["city"]) or "").title() or None,
        "situs_zip": str(attrs.get(F["zip"]) or "")[:5] or None,
        "mailing_address": mail_raw,
        "mailing_city": (attrs.get(F["mailcity"]) or "").upper() or None,
        "mailing_zip": str(attrs.get(F["mailzip"]) or "")[:5] or None,
        "mailing_same_as_situs": same,
        "sqft": int(attrs.get(F["sqft"]) or 0) or None,
        "market_value": float(attrs.get(F["value"]) or 0) or None,
        "year_built": attrs.get(F["year_built"]) or None,
        "property_class": attrs.get(F["class"]) or None,
        "owner1_raw": attrs.get(F["owner"]),
        "owner2_raw": attrs.get(F["owner2"]),
        "lat": attrs.get("__lat"),
        "lng": attrs.get("__lng"),
        "source_payload": {
            **{k: v for k, v in attrs.items() if not k.startswith("__")},
            "last_sale_date": sale_date.isoformat() if sale_date else None,
            "last_sale_price": sale.get("sale_price"),
            "years_owned": years_owned(sale_date),
            "institutional_owner": institutional_owner(attrs.get(F["owner"])),
        },
        "refreshed_at": datetime.utcnow().isoformat() + "Z",
    }


def main() -> None:
    require_env()
    sales = fetch_sales_index()

    rows: list[dict] = []
    seen: set[str] = set()
    for zip_code in TARGET_ZIPS:
        print(f"[arcgis] {FEATURE_SERVER} where zip={zip_code} city in {TARGET_CITIES}")
        gross = 0
        for attrs in fetch_arcgis(zip_code):
            gross += 1
            r = to_row(attrs, sales)
            if r:
                rows.append(r)
                seen.add(r["county_parcel_id"])
        print(f"[arcgis] zip {zip_code}: {gross} returned, {len(rows)} kept")

    if not rows:
        sys.exit("no parcels; refusing to write empty dataset")

    upsert("parcels", rows, on_conflict="county_parcel_id", batch_size=500)
    print(f"[supabase] upserted {len(rows)} parcels")


if __name__ == "__main__":
    main()
