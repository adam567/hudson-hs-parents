"""Thin Supabase REST client used by all ingest scripts.

Uses the service-role key (no RLS). Never ship the service key to the browser.
"""
from __future__ import annotations

import json
import os
import sys
from typing import Any, Iterable

import requests


SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")


def require_env() -> None:
    missing = [k for k, v in {
        "SUPABASE_URL": SUPABASE_URL,
        "SUPABASE_SERVICE_ROLE_KEY": SERVICE_KEY,
    }.items() if not v]
    if missing:
        sys.exit(f"missing env vars: {', '.join(missing)}")


def request(method: str, path: str, **kwargs) -> requests.Response:
    headers = kwargs.pop("headers", {}) or {}
    headers.update({
        "apikey": SERVICE_KEY,
        "Authorization": f"Bearer {SERVICE_KEY}",
        "Content-Type": "application/json",
    })
    url = f"{SUPABASE_URL}/rest/v1{path}"
    r = requests.request(method, url, headers=headers, timeout=120, **kwargs)
    if not r.ok:
        sys.exit(f"supabase {method} {path} -> {r.status_code}: {r.text[:600]}")
    return r


def upsert(table: str, rows: list[dict], on_conflict: str | None = None,
           batch_size: int = 500, return_repr: bool = False) -> list[dict]:
    if not rows:
        return []
    path = f"/{table}"
    if on_conflict:
        path += f"?on_conflict={on_conflict}"
    prefer = "resolution=merge-duplicates"
    if return_repr:
        prefer += ",return=representation"
    else:
        prefer += ",return=minimal"
    out: list[dict] = []
    for i in range(0, len(rows), batch_size):
        batch = rows[i:i + batch_size]
        r = request("POST", path,
                    headers={"Prefer": prefer},
                    data=json.dumps(batch, default=str))
        if return_repr and r.text:
            out.extend(r.json())
    return out


def truncate(table: str, where_param: str | None = None) -> None:
    """DELETE rows from a table; required for full-refresh ingest patterns.

    where_param is appended raw to the query (e.g. 'batch_label=eq.spring2026').
    Without where_param, deletes everything (intentional — the caller knows).
    """
    path = f"/{table}"
    if where_param:
        path += f"?{where_param}"
    else:
        # Postgres requires a WHERE for DELETE through PostgREST; use a tautology.
        path += "?id=neq.00000000-0000-0000-0000-000000000000"
    request("DELETE", path)


def call_rpc(name: str, payload: dict | None = None) -> Any:
    headers = {
        "apikey": SERVICE_KEY,
        "Authorization": f"Bearer {SERVICE_KEY}",
        "Content-Type": "application/json",
    }
    url = f"{SUPABASE_URL}/rest/v1/rpc/{name}"
    r = requests.post(url, headers=headers, data=json.dumps(payload or {}, default=str), timeout=180)
    if not r.ok:
        sys.exit(f"rpc {name} -> {r.status_code}: {r.text[:600]}")
    return r.json() if r.text else None
