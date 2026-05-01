#!/usr/bin/env python3
"""Send the daily/weekly campaign digest to operators whose preferences ask for it.

Runs from a GitHub Actions cron. For each user_preferences row where:
  - email_cadence != 'off'
  - email_cadence != 'on_demand' (those are sent only when she clicks)
  - cadence-day matches today (e.g., weekly_monday only on Mondays)
  - they have an active campaign
we build a short HTML digest of the unwalked Tier-1/2/3 doors that became
relevant since their last_seen_at, and send it via Resend.

Required env:
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
  RESEND_API_KEY  (or set DIGEST_DRY_RUN=1 to skip sending)
  DIGEST_FROM     ("Hudson HS Parents <noreply@yourdomain.com>")
"""
from __future__ import annotations

import json
import os
import sys
from datetime import date, datetime, timezone

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from supabase_client import require_env, request as sb_request

RESEND_KEY = os.environ.get("RESEND_API_KEY", "")
DIGEST_FROM = os.environ.get("DIGEST_FROM", "Hudson HS Parents <noreply@example.com>")
DRY = os.environ.get("DIGEST_DRY_RUN", "").lower() in ("1", "true", "yes")


def cadence_due(cadence: str, today: date) -> bool:
    if cadence == "daily":
        return True
    if cadence == "weekdays":
        return today.weekday() < 5
    if cadence == "weekly_monday":
        return today.weekday() == 0
    return False  # 'off' / 'on_demand' handled by caller


def fetch_users() -> list[dict]:
    r = sb_request("GET",
        "/user_preferences?select=user_id,email_cadence,email_send_hour_local,default_campaign_id&"
        "email_cadence=in.(daily,weekdays,weekly_monday)")
    return r.json() or []


def fetch_user_email(user_id: str) -> str | None:
    # auth.users isn't reachable via PostgREST; we use the admin endpoint.
    base = os.environ["SUPABASE_URL"].rstrip("/")
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    r = requests.get(f"{base}/auth/v1/admin/users/{user_id}",
                     headers={"apikey": key, "Authorization": f"Bearer {key}"},
                     timeout=30)
    if not r.ok:
        return None
    return (r.json() or {}).get("email")


def fetch_active_campaign(user_id: str) -> dict | None:
    r = sb_request("GET",
        f"/campaigns?select=id,name,anchor_date&user_id=eq.{user_id}&is_active=eq.true&order=started_at.desc&limit=1")
    rows = r.json() or []
    return rows[0] if rows else None


TIER_LABEL = {
    "T1":  "Confirmed Senior",
    "T2":  "Likely Senior — List Match",
    "T4":  "Possible Senior — List Match + Parent-Aged Voter",
    "T2b": "Two Parent-Aged Adults — 8+ Years",
    "T5":  "List Match",
    "T3":  "Recent Grad",
}
TIER_LABEL_SHORT = {
    "T1": "Confirmed", "T2": "List+2", "T4": "List+1",
    "T2b": "2 voters/8+yr", "T5": "List only", "T3": "Recent grad",
}
TIER_RANK = {"T1": 1, "T2": 2, "T4": 3, "T2b": 4, "T5": 5, "T3": 6}
DEFAULT_DIGEST_TIERS = ("T1", "T2", "T4", "T2b")


def _sanitize(s: str) -> str:
    return (s or "").replace("Datazapp College-Bound match", "matched a national college-bound parents list").replace("Datazapp", "the national parents list")


def fetch_top_doors(campaign_id: str, since_iso: str | None) -> list[dict]:
    """Top households per priority tier (defaults to T1, T2, T4, T2b)."""
    tier_filter = ",".join(DEFAULT_DIGEST_TIERS)
    r = sb_request("GET",
        "/v_targets?select=household_id,display_name,situs_address,situs_city,tier,evidence_score,why_sentence&"
        f"tier=in.({tier_filter})&order=evidence_score.desc&limit=12")
    return r.json() or []


def render_html(name: str, camp: dict, doors: list[dict]) -> str:
    counts: dict[str, int] = {}
    for d in doors:
        t = d.get("tier", "")
        counts[t] = counts.get(t, 0) + 1
    summary = " · ".join(
        f"{TIER_LABEL_SHORT.get(code, code)}: {counts[code]}"
        for code in sorted(counts, key=lambda t: TIER_RANK.get(t, 99))
        if counts[code]
    )
    rows = "".join(
        f'<tr><td style="padding:6px 8px;border-bottom:1px solid #e6e2d8"><strong>{d.get("situs_address") or "—"}</strong>'
        f'<br><span style="color:#6b6b70;font-size:12px">{d.get("display_name") or ""}</span></td>'
        f'<td style="padding:6px 8px;border-bottom:1px solid #e6e2d8;font-weight:600">{TIER_LABEL.get(d.get("tier", ""), d.get("tier") or "—")}</td>'
        f'<td style="padding:6px 8px;border-bottom:1px solid #e6e2d8;color:#6b6b70;font-size:12px">{_sanitize(d.get("why_sentence") or "")}</td></tr>'
        for d in doors
    )
    return f"""
    <div style="font:14px/1.5 -apple-system,Segoe UI,system-ui,sans-serif;color:#1d1d1f;max-width:600px">
      <h2 style="margin:0 0 6px">{camp['name']}</h2>
      <div style="color:#6b6b70;font-size:13px;margin-bottom:14px">
        Anchor {camp['anchor_date']} · {len(doors)} top doors · {summary}
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <tbody>{rows}</tbody>
      </table>
      <p style="margin-top:14px;font-size:12px;color:#6b6b70">
        Open the map to plan your walk → <a href="https://adam567.github.io/hudson-hs-parents/">Hudson HS Parents</a>
      </p>
    </div>
    """


def send_email(to: str, subject: str, html: str) -> None:
    if DRY or not RESEND_KEY:
        print(f"[dry-run] would email {to}: {subject}")
        return
    r = requests.post("https://api.resend.com/emails",
        headers={"Authorization": f"Bearer {RESEND_KEY}", "Content-Type": "application/json"},
        data=json.dumps({"from": DIGEST_FROM, "to": [to], "subject": subject, "html": html}),
        timeout=20)
    if not r.ok:
        print(f"[send] {to} -> {r.status_code}: {r.text[:200]}", file=sys.stderr)


def main() -> None:
    require_env()
    today = datetime.now(tz=timezone.utc).date()
    users = fetch_users()
    print(f"[digest] {len(users)} candidate users")

    for u in users:
        cadence = u.get("email_cadence")
        if not cadence_due(cadence, today):
            continue
        camp = fetch_active_campaign(u["user_id"])
        if not camp:
            continue
        email = fetch_user_email(u["user_id"])
        if not email:
            continue
        doors = fetch_top_doors(camp["id"], None)
        if not doors:
            print(f"[digest] no doors for {email}; skipping")
            continue
        subject = f"{camp['name']} — {len(doors)} doors ready today"
        html = render_html(email, camp, doors)
        send_email(email, subject, html)
        print(f"[digest] sent to {email}: {len(doors)} doors")


if __name__ == "__main__":
    main()
