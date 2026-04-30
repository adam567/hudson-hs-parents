"""Canonical address normalization shared across parcel, voter, and Datazapp data.

The single source of truth for joining records by residence address.

Use `address_key()` for the join key. Use `address_display()` for human-readable.
"""
from __future__ import annotations

import re
from typing import Optional

USPS_SUFFIX = {
    "STREET": "ST", "ST.": "ST",
    "AVENUE": "AVE", "AV": "AVE", "AVE.": "AVE",
    "ROAD": "RD", "RD.": "RD",
    "DRIVE": "DR", "DR.": "DR",
    "BOULEVARD": "BLVD", "BLVD.": "BLVD", "BOULEVARDE": "BLVD",
    "LANE": "LN", "LN.": "LN",
    "COURT": "CT", "CT.": "CT",
    "CIRCLE": "CIR", "CIR.": "CIR",
    "PLACE": "PL", "PL.": "PL",
    "PARKWAY": "PKWY", "PKWY.": "PKWY",
    "TERRACE": "TER", "TER.": "TER", "TERR": "TER",
    "TRAIL": "TRL", "TRL.": "TRL",
    "WAY": "WAY",
    "HIGHWAY": "HWY", "HWY.": "HWY",
    "SQUARE": "SQ",
    "ROUTE": "RTE",
    "POINT": "PT",
    "PIKE": "PIKE",
    "RUN": "RUN",
    "PASS": "PASS",
    "RIDGE": "RDG", "RDG.": "RDG",
    "CROSSING": "XING",
    "BEND": "BND",
    "LOOP": "LOOP",
    "PATH": "PATH",
    "WALK": "WALK",
    "OVAL": "OVAL",
}
USPS_DIRECTION = {
    "NORTH": "N", "SOUTH": "S", "EAST": "E", "WEST": "W",
    "NORTHEAST": "NE", "NORTHWEST": "NW", "SOUTHEAST": "SE", "SOUTHWEST": "SW",
    "N.": "N", "S.": "S", "E.": "E", "W.": "W",
    "N.E.": "NE", "N.W.": "NW", "S.E.": "SE", "S.W.": "SW",
}
UNIT_TOKENS = {
    "APT", "APARTMENT", "UNIT", "STE", "SUITE", "BLDG", "BUILDING",
    "FL", "FLOOR", "RM", "ROOM", "#",
}

APOSTROPHE_RX = re.compile(r"['’‘`]")  # straight, curly, backtick
PUNCT_RX = re.compile(r"[^A-Z0-9 #]")
WS_RX = re.compile(r"\s+")


def _expand_token(t: str) -> str:
    if t in USPS_DIRECTION:
        return USPS_DIRECTION[t]
    if t in USPS_SUFFIX:
        return USPS_SUFFIX[t]
    return t


def _strip_punct(s: str) -> str:
    return PUNCT_RX.sub(" ", s)


def address_key(
    house_num: Optional[str | int] = None,
    direction: Optional[str] = None,
    street_name: Optional[str] = None,
    apt: Optional[str] = None,
    full_address: Optional[str] = None,
) -> str:
    """Return a canonical, joinable address key.

    Two ways to call:
      - parts: address_key(house_num, direction, street_name, apt)
      - full:  address_key(full_address="123 N MAIN ST APT 4B")
    """
    if full_address is not None:
        s = full_address
    else:
        parts = []
        if house_num is not None and str(house_num).strip():
            parts.append(str(house_num).strip())
        if direction and str(direction).strip():
            parts.append(str(direction).strip())
        if street_name and str(street_name).strip():
            parts.append(str(street_name).strip())
        if apt and str(apt).strip():
            parts.append("APT " + str(apt).strip())
        s = " ".join(parts)

    if not s:
        return ""

    s = s.upper()
    s = APOSTROPHE_RX.sub("", s)  # delete apostrophes (join O'BRIEN → OBRIEN)
    s = _strip_punct(s)
    s = WS_RX.sub(" ", s).strip()

    tokens = s.split(" ")
    # Strip leading "APT" from a unit token if it duplicates (e.g., "APT APT 4B")
    out_tokens: list[str] = []
    i = 0
    while i < len(tokens):
        t = tokens[i]
        if t in UNIT_TOKENS:
            # Collapse to a normalized "#<value>" form
            value_parts = []
            j = i + 1
            while j < len(tokens):
                value_parts.append(tokens[j])
                j += 1
            unit_value = " ".join(value_parts).lstrip("#").strip()
            if unit_value:
                out_tokens.append("#" + unit_value)
            break
        out_tokens.append(_expand_token(t))
        i += 1

    return " ".join(out_tokens).strip()


def address_display(
    house_num: Optional[str | int] = None,
    direction: Optional[str] = None,
    street_name: Optional[str] = None,
    apt: Optional[str] = None,
    full_address: Optional[str] = None,
) -> str:
    """Mixed-case human-readable form, suitable for UI.

    Either pass the parts or pass `full_address` for a one-shot pretty-print.
    """
    if full_address is not None:
        s = str(full_address).strip()
        if not s:
            return ""
        # Title-case but preserve directionals (N S E W NE NW SE SW) as uppercase
        out = []
        for tok in s.split():
            up = tok.upper().rstrip(".,")
            if up in {"N", "S", "E", "W", "NE", "NW", "SE", "SW"}:
                out.append(up)
            elif up.startswith("#"):
                out.append(up)
            else:
                out.append(tok.capitalize())
        return " ".join(out)

    parts = []
    if house_num is not None and str(house_num).strip():
        parts.append(str(house_num).strip())
    if direction and str(direction).strip():
        parts.append(str(direction).strip().upper())
    if street_name and str(street_name).strip():
        sn = " ".join(w.capitalize() for w in str(street_name).strip().split())
        parts.append(sn)
    base = " ".join(parts)
    if apt and str(apt).strip():
        return f"{base} Apt {str(apt).strip()}"
    return base
