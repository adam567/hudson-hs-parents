"""Unit tests for the canonical address-normalization library.

Run: python -m pytest tests/ -v   (from repo root)
or:  python tests/test_address_key.py
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from scripts.address_key import address_key, address_display


def test_voter_to_full_collision():
    a = address_key(house_num="53", direction="W", street_name="Case Dr")
    b = address_key(full_address="53 W Case Drive")
    assert a == b == "53 W CASE DR"


def test_parcel_to_datazapp_collision():
    a = address_key(full_address="252 S MAIN ST")
    b = address_key(full_address="252 S Main Street")
    assert a == b == "252 S MAIN ST"


def test_apt_normalization():
    a = address_key(full_address="123 Hudson Park Dr Apt 4B")
    b = address_key(full_address="123 Hudson Park Drive #4B")
    c = address_key(full_address="123 Hudson Park Drive Unit 4B")
    assert a == b == c == "123 HUDSON PARK DR #4B"


def test_directional_variants():
    a = address_key(full_address="1649 East Haymarket Way")
    b = address_key(full_address="1649 E Haymarket Way")
    c = address_key(full_address="1649 E. Haymarket Way")
    assert a == b == c == "1649 E HAYMARKET WAY"


def test_punctuation_strip():
    a = address_key(full_address="115 College St,")
    b = address_key(full_address="115 College Street.")
    c = address_key(full_address="115  College  ST")
    assert a == b == c == "115 COLLEGE ST"


def test_all_directionals():
    for long, short in [("North", "N"), ("South", "S"), ("East", "E"), ("West", "W"),
                        ("Northeast", "NE"), ("Northwest", "NW"),
                        ("Southeast", "SE"), ("Southwest", "SW")]:
        assert address_key(full_address=f"100 {long} Main St") == \
               address_key(full_address=f"100 {short} Main St") == \
               f"100 {short} MAIN ST"


def test_common_suffixes():
    cases = [
        ("Avenue", "AVE"), ("Av", "AVE"),
        ("Road", "RD"),
        ("Boulevard", "BLVD"),
        ("Lane", "LN"),
        ("Court", "CT"),
        ("Circle", "CIR"),
        ("Place", "PL"),
        ("Parkway", "PKWY"),
        ("Trail", "TRL"),
        ("Highway", "HWY"),
        ("Terrace", "TER"),
        ("Ridge", "RDG"),
    ]
    for long, short in cases:
        a = address_key(full_address=f"7 Maple {long}")
        assert a == f"7 MAPLE {short}", f"{long} -> {a}"


def test_empty_inputs():
    assert address_key(full_address="") == ""
    assert address_key(full_address=None) == ""
    assert address_key() == ""
    assert address_key(house_num="", street_name="") == ""


def test_display_preserves_directionals():
    assert address_display(full_address="53 W CASE DR") == "53 W Case Dr"
    assert address_display(full_address="1649 E HAYMARKET WAY") == "1649 E Haymarket Way"
    assert address_display(house_num="7659", street_name="HUDSON PARK DR") == "7659 Hudson Park Dr"


def test_display_apt():
    assert address_display(full_address="123 MAIN ST #4B") == "123 Main St #4B"


def test_unicode_safe():
    a = address_key(full_address="100 O'Brien Ln")
    b = address_key(full_address="100 OBRIEN LN")
    # Apostrophe stripped by punct rule, both reduce to same key
    assert a == b


if __name__ == "__main__":
    import inspect
    fns = [f for n, f in globals().items() if n.startswith("test_") and inspect.isfunction(f)]
    fail = 0
    for f in fns:
        try:
            f()
            print(f"OK    {f.__name__}")
        except AssertionError as e:
            fail += 1
            print(f"FAIL  {f.__name__}: {e}")
    sys.exit(fail)
