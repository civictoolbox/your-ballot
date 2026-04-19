#!/usr/bin/env python3
"""
build_party_data.py
───────────────────
Post-processes the per-council JSONs in data/councils/ into:

  data/parties-index.json            — small aggregate index (~5 KB)
  data/parties-candidates/<key>.json — per-party candidate list (lazy-loaded)

Depends on the output of scripts/build_browse_data.py. No API calls —
pure local file processing. Runs in seconds.

Run locally:
  python3 scripts/build_party_data.py

Run in CI: chained after build_browse_data.py in .github/workflows/enrich.yml.
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
COUNCILS_DIR = DATA_DIR / "councils"
PARTY_INDEX_PATH = DATA_DIR / "parties-index.json"
PARTY_CANDIDATES_DIR = DATA_DIR / "parties-candidates"


# ── Party canonicalisation ──────────────────────────────────────────────────
# Known major parties merge to a canonical key (mirrors partyKey() in
# js/app.js and js/all.js). Unknown parties get their own slugified key so
# they show up individually in the browse list instead of vanishing into a
# giant "Other" bucket — this matters for civic transparency.
import re as _re

def _slugify(name: str) -> str:
    n = _re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")
    return n or "unknown"

def party_key(party_name: str) -> str:
    n = (party_name or "").lower()
    if not n:
        return "independent"
    if "labour" in n and "co-op" in n:
        return "labour-coop"
    if "labour" in n:
        return "labour"
    if "conservative" in n:
        return "conservative"
    if "liberal democrat" in n:
        return "libdem"
    if "green party" in n:
        return "green"
    if "reform uk" in n or n.strip() == "reform uk":
        return "reform"
    if "plaid cymru" in n:
        return "plaid"
    if "scottish national" in n:
        return "snp"
    if "sinn féin" in n or "sinn fein" in n:
        return "sinn-fein"
    if ("dup" in n) or ("democratic unionist" in n):
        return "dup"
    # Alliance Party of NI — check BEFORE generic Alliance
    if "alliance party" in n:
        return "alliance"
    if n.strip() == "alliance":
        return "alliance"
    if "sdlp" in n:
        return "sdlp"
    if "uup" in n or "ulster unionist" in n:
        return "uup"
    # Minor national parties with published platforms
    if "trade unionist and socialist" in n:
        return "tusc"
    if "workers party" in n:
        return "workers-party"
    if "social democratic party" in n or n.strip() == "sdp":
        return "sdp"
    if "heritage party" in n:
        return "heritage"
    if "rejoin eu" in n:
        return "rejoin-eu"
    if "advance uk" in n:
        return "advance-uk"
    if "ukip" in n or "uk independence party" in n:
        return "ukip"
    if n.strip() == "aspire":
        return "aspire"
    if "communist party of britain" in n:
        return "communist"
    if "independent" in n:
        return "independent"
    # Anything else becomes its own slot rather than collapsing into "other".
    return f"party-{_slugify(party_name)}"


# Human-readable names per canonical key — fallback when there's no parties.json entry.
DISPLAY_NAMES = {
    "labour":       "Labour Party",
    "labour-coop":  "Labour and Co-operative Party",
    "conservative": "Conservative Party",
    "libdem":       "Liberal Democrats",
    "green":        "Green Party",
    "reform":       "Reform UK",
    "plaid":        "Plaid Cymru",
    "snp":          "Scottish National Party",
    "sinn-fein":    "Sinn Féin",
    "dup":          "Democratic Unionist Party",
    "alliance":     "Alliance Party",
    "sdlp":         "Social Democratic and Labour Party",
    "uup":          "Ulster Unionist Party",
    "tusc":         "Trade Unionist and Socialist Coalition",
    "workers-party":"Workers Party of Britain",
    "sdp":          "Social Democratic Party",
    "heritage":     "Heritage Party",
    "rejoin-eu":    "Rejoin EU",
    "advance-uk":   "Advance UK",
    "ukip":         "UK Independence Party",
    "aspire":       "Aspire",
    "communist":    "Communist Party of Britain",
    "independent":  "Independent",
    "other":        "Other parties",
}


def log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def main() -> int:
    if not COUNCILS_DIR.exists():
        log(f"No {COUNCILS_DIR} — run scripts/build_browse_data.py first.")
        return 1

    council_files = sorted(COUNCILS_DIR.glob("*.json"))
    if not council_files:
        log(f"{COUNCILS_DIR} is empty. Nothing to do.")
        return 1

    log(f"Reading {len(council_files)} council files…")

    # key -> list of candidate dicts (with council/ward context)
    parties: dict[str, list[dict]] = {}
    # key -> {council_slug, council_name} set  (counted later)
    party_councils: dict[str, set[str]] = {}
    # key -> the specific raw party names seen under this canonical key
    party_raw_names: dict[str, set[str]] = {}

    for cf in council_files:
        try:
            data = json.loads(cf.read_text())
        except Exception as e:
            log(f"  skip {cf.name}: {e}")
            continue
        meta = data.get("_meta") or {}
        council_slug = meta.get("council_slug") or cf.stem
        council_name = meta.get("council_name") or council_slug

        for w in data.get("wards") or []:
            ward_name = w.get("ward_name") or ""
            for c in w.get("candidates") or []:
                name = c.get("name") or ""
                pid = c.get("person_id")
                raw_party = c.get("party_name") or "Independent"
                key = party_key(raw_party)
                parties.setdefault(key, []).append({
                    "person_id": pid,
                    "name": name,
                    "party_name": raw_party,
                    "council_slug": council_slug,
                    "council_name": council_name,
                    "ward_name": ward_name,
                })
                party_councils.setdefault(key, set()).add(council_slug)
                party_raw_names.setdefault(key, set()).add(raw_party)

    log(f"Grouped {sum(len(v) for v in parties.values())} candidacies into {len(parties)} parties.")

    # ── Write per-party candidate lists ────────────────────────────────────
    PARTY_CANDIDATES_DIR.mkdir(parents=True, exist_ok=True)
    for stale in PARTY_CANDIDATES_DIR.glob("*.json"):
        stale.unlink()

    def display_for(key: str) -> str:
        if key in DISPLAY_NAMES:
            return DISPLAY_NAMES[key]
        # Fallback for "party-<slug>" keys: use the most common raw party
        # name we saw for this key. Covers edge cases where a single canonical
        # key gathered variants.
        raws = sorted(party_raw_names.get(key, []))
        if raws:
            return raws[0]
        return key.replace("-", " ").title()

    now_iso = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    for key, candidates in parties.items():
        # Sort by candidate surname, then council
        candidates.sort(key=lambda c: (
            (c.get("name") or "").split()[-1].lower(),
            c.get("council_name") or "",
            c.get("ward_name") or "",
        ))
        out = {
            "_meta": {
                "generated_at": now_iso,
                "party_key": key,
                "display_name": display_for(key),
                "candidate_count": len(candidates),
                "council_count": len(party_councils.get(key, set())),
                "raw_party_names": sorted(party_raw_names.get(key, [])),
            },
            "candidates": candidates,
        }
        (PARTY_CANDIDATES_DIR / f"{key}.json").write_text(
            json.dumps(out, indent=2, ensure_ascii=False)
        )

    # ── Write the small index ──────────────────────────────────────────────
    entries = [{
        "key": key,
        "display_name": display_for(key),
        "candidate_count": len(parties[key]),
        "council_count": len(party_councils.get(key, set())),
    } for key in parties.keys()]
    entries.sort(key=lambda e: (-e["candidate_count"], e["display_name"]))

    total_cands = sum(e["candidate_count"] for e in entries)
    index_out = {
        "_meta": {
            "generated_at": now_iso,
            "party_count": len(entries),
            "candidate_count": total_cands,
        },
        "parties": entries,
    }
    PARTY_INDEX_PATH.write_text(json.dumps(index_out, indent=2, ensure_ascii=False))
    log(f"Wrote {PARTY_INDEX_PATH.name} ({len(entries)} parties, {total_cands:,} candidacies).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
