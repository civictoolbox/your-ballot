#!/usr/bin/env python3
"""
build_browse_data.py
────────────────────
FAST pass over Democracy Club's YNR API that only fetches what the browse
page needs:
  • the list of ballots on ELECTION_DATE
  • each ballot's candidacies (candidate name + party only)

It writes:
  • data/elections-index.json     — council-level summary + ward names
  • data/councils/<slug>.json     — per-council ward + candidate detail
  • data/ballot_person_ids.json   — de-duplicated list of person IDs for the
                                    slower enrichment script to pick up

Runtime: roughly 15–20 min against YNR with the polite rate-limit settings
in scripts/enrich_candidates.py. Runs cleanly inside a 45-minute CI timeout.

Run locally:
  python3 scripts/build_browse_data.py

Run in CI: the first step of .github/workflows/enrich.yml. Separate from the
enrichment step so browse data can be committed and go live even if the
downstream per-person loop later times out.
"""
from __future__ import annotations

import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

# Reuse the helpers the slower script already ships
THIS = Path(__file__).resolve()
sys.path.insert(0, str(THIS.parent))
from enrich_candidates import (  # noqa: E402
    ELECTION_DATE,
    INTER_REQUEST_SLEEP,
    DATA_DIR,
    INDEX_PATH,
    COUNCILS_DIR,
    log,
    iter_ballots,
    fetch_ballot_detail,
    extract_council_slug,
    write_elections_browse_data,
)

PERSON_IDS_PATH = DATA_DIR / "ballot_person_ids.json"


def main() -> int:
    start = time.time()
    log(f"Browse-data build starting for {ELECTION_DATE}.")

    # 1. Collect ballot IDs
    ballot_ids: list[str] = []
    for b in iter_ballots(ELECTION_DATE):
        bpi = b.get("ballot_paper_id")
        if bpi and not b.get("cancelled"):
            ballot_ids.append(bpi)
    log(f"Collected {len(ballot_ids)} active ballots.")

    if not ballot_ids:
        log("No ballots found — aborting without writing.")
        return 1

    # 2. For each ballot, fetch detail for candidacies
    councils_wards: dict[str, list[dict]] = {}
    council_names: dict[str, str] = {}
    person_ids: set[int] = set()

    for i, bpi in enumerate(ballot_ids, 1):
        if i % 50 == 0:
            log(f"  …processed {i}/{len(ballot_ids)} ballots")
        b = fetch_ballot_detail(bpi)
        time.sleep(INTER_REQUEST_SLEEP)
        if not b:
            continue

        council_slug = extract_council_slug(bpi)
        org = (b.get("election") or {}).get("organization") or {}
        if council_slug and council_slug not in council_names:
            council_names[council_slug] = (
                org.get("common_name")
                or org.get("official_name")
                or council_slug.replace("-", " ").title()
            )

        ward_label = (b.get("post") or {}).get("label") or ""
        winner_count = b.get("winner_count") or 1

        ward_candidates: list[dict] = []
        for c in b.get("candidacies") or []:
            p = c.get("person") or {}
            pid = p.get("id")
            name = p.get("name")
            if isinstance(pid, int):
                person_ids.add(pid)
            party = c.get("party") or {}
            party_name = party.get("name") or c.get("party_name") or "Independent"
            if pid and name:
                ward_candidates.append({
                    "person_id": pid,
                    "name": name,
                    "party_name": party_name,
                })

        if council_slug and ward_label:
            councils_wards.setdefault(council_slug, []).append({
                "ward_name": ward_label,
                "ballot_paper_id": bpi,
                "seats_contested": winner_count,
                "candidate_count": len(ward_candidates),
                "candidates": ward_candidates,
            })

    log(f"Found {len(person_ids)} unique candidates across {len(councils_wards)} councils.")

    # 3. Write browse JSONs
    write_elections_browse_data(councils_wards, council_names)

    # 4. Write person-ID list for the enrichment step to pick up
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    PERSON_IDS_PATH.write_text(json.dumps({
        "_meta": {
            "election_date": ELECTION_DATE,
            "generated_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
            "count": len(person_ids),
        },
        "person_ids": sorted(person_ids),
    }, indent=2))
    log(f"Wrote {PERSON_IDS_PATH.name} ({len(person_ids)} IDs).")

    elapsed = time.time() - start
    log(f"Browse-data build done in {elapsed:.1f}s.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
